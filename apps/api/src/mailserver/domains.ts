import * as addressesDb from '../db/addresses'
import { requireRoom } from '../limits'
import * as domainsDb from '../db/domains'
import * as membersDb from '../db/members'
import { domainAccess, domainContext, isAdmin, loadMember, requireOrgPermission } from './access'
import { EmailError } from './errors'
import { checkRecords, isTestDomain, lookupDomain, otherMxHosts, resolveTxt, storeRecords, zoneFile, type DnsProvider, type DnsRecord } from './dns'
import * as domainConnect from './domain-connect'
import * as ses from './ses'
import { toDomain, type Actor, type Domain, type EmailEnv } from './types'
import { normalizeDomain } from './validation'
import { noBackground, track, type Background } from '../analytics/events'

/** Adds a domain to the organization. A plain member who adds it gets manage access to it. */
export async function addDomain(env: EmailEnv, actor: Actor, organizationId: string, name: string): Promise<Domain> {
  const member = await loadMember(env, organizationId, actor.userId)
  requireOrgPermission(member, 'domains.create')

  name = normalizeDomain(name)
  if (await domainsDb.nameTaken(env.DB, name)) throw new EmailError('domain_taken', `${name} is already added to xstate`, 409)
  await requireRoom(env, organizationId, 'domains')

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  // stalwart_id is NOT NULL UNIQUE until the table rebuild in phase 5c; nothing reads it any more.
  const writes = [domainsDb.insert(env.DB, { id, organizationId, name, stalwartId: `none:${id}`, createdBy: actor.userId, now, mailPath: 'store' })]
  if (!isAdmin(member) && domainAccess(member, id) !== 'manage') {
    const permissions = { ...member.permissions, domains: { ...member.permissions.domains, [id]: 'manage' as const } }
    writes.push(membersDb.setPermissions(env.DB, member.id, permissions, now))
  }
  await env.DB.batch(writes)

  // Register for sending through SES now, so its DKIM records are part of the DNS step. If SES is down, the next
  // "Check DNS" (verifyDomain) tries again.
  await syncSes(env, (await domainsDb.find(env.DB, id))!).catch((err) => console.error(`ses: registering ${name} failed`, err))
  return toDomain((await domainsDb.find(env.DB, id))!)
}

/**
 * Registers the domain with SES if it isn't yet, otherwise refreshes SES's verification status. Returns the
 * up-to-date row. Does nothing when SES isn't configured.
 */
async function syncSes(env: EmailEnv, domain: domainsDb.DomainRow): Promise<domainsDb.DomainRow> {
  if (!ses.sesConfigured(env) || domain.ses_status === 'verified') return domain
  const identity = domain.ses_status
    ? ((await ses.getDomainIdentity(env, domain.name)) ?? (await ses.registerDomain(env, domain.name)))
    : await ses.registerDomain(env, domain.name)
  if (identity.status === domain.ses_status && JSON.stringify(identity.dkimTokens) === domain.ses_dkim_tokens) return domain
  // Set the topics again as the domain becomes verified: one registered before delivery notifications existed
  // only has bounces and complaints. A failure here mustn't block verification; the next check doesn't retry it.
  if (identity.status === 'verified') {
    await ses.setNotificationTopics(env, domain.name).catch((err) => console.error(`ses: notification topics for ${domain.name} failed`, err))
  }
  await domainsDb.setSes(env.DB, domain.id, identity, new Date().toISOString()).run()
  return (await domainsDb.find(env.DB, domain.id))!
}

/**
 * Hourly: refreshes SES status for domains it hasn't verified yet. SES verifies DKIM on its own schedule, so a
 * domain whose mail records were already found would otherwise stay "sending pending" until someone checks again.
 */
export async function sesHourly(env: EmailEnv): Promise<{ checked: number; changed: number }> {
  if (!ses.sesConfigured(env)) return { checked: 0, changed: 0 }
  const rows = await domainsDb.listSesUnverified(env.DB, 50)
  let changed = 0
  for (const row of rows) {
    try {
      const after = await syncSes(env, row)
      if (after.ses_status !== row.ses_status) changed++
    } catch (err) {
      console.error(`ses: hourly sync of ${row.name} failed`, err)
    }
  }
  return { checked: rows.length, changed }
}

const sesDkimRecords = (domain: domainsDb.DomainRow) =>
  ses.dkimRecords(domain.ses_dkim_tokens ? (JSON.parse(domain.ses_dkim_tokens) as string[]) : [])

export async function getDomain(env: EmailEnv, actor: Actor, domainId: string): Promise<Domain> {
  const { domain } = await domainContext(env, actor, domainId, 'read')
  return toDomain(domain)
}

/** Domains in the organization that the actor can see. */
export async function listDomains(env: EmailEnv, actor: Actor, organizationId: string): Promise<Domain[]> {
  const member = await loadMember(env, organizationId, actor.userId)
  const [rows, opened] = await Promise.all([
    domainsDb.listByOrganization(env.DB, organizationId),
    // Plus the domains of mailboxes they can open (their own, shared ones), so a member with no domain permissions
    // still sees their addresses grouped under their domain. Listing gives no access to the domain itself.
    env.DB.prepare('SELECT DISTINCT a.domain_id FROM mailbox_access ma JOIN addresses a ON a.mailbox_id = ma.mailbox_id WHERE ma.member_id = ?')
      .bind(member.id)
      .all<{ domain_id: string }>(),
  ])
  const mine = new Set(opened.results.map((r) => r.domain_id))
  return rows.filter((d) => domainAccess(member, d.id) || mine.has(d.id)).map(toDomain)
}

/** The DNS records the customer must add (Amazon SES receiving and sending: MX, SPF, DKIM, DMARC), as a zone file. */
export async function getDomainDnsRecords(env: EmailEnv, actor: Actor, domainId: string): Promise<string> {
  const { domain } = await domainContext(env, actor, domainId, 'read')
  return zoneFile(domain.name, storeRecords(env.AWS_SES_REGION, sesDkimRecords(domain)))
}

/**
 * Before adding a domain: whether the name is valid, exists in public DNS, is free on xstate, and which provider
 * hosts its DNS. Onboarding uses the provider to tailor the verification step.
 */
export async function checkDomain(
  env: EmailEnv,
  name: string,
): Promise<{ name: string; registered: boolean; taken: boolean; provider: DnsProvider | null }> {
  name = normalizeDomain(name)
  const testLookup = { registered: true, provider: null }
  const [lookup, taken] = await Promise.all([
    isTestDomain(env, name) ? testLookup : lookupDomain(name),
    domainsDb.nameTaken(env.DB, name),
  ])
  return { name, taken, ...lookup }
}

/**
 * Checks public DNS for the records mail needs. When every required record is found, the domain is marked
 * verified. Safe to poll: a verified domain stays verified, and the records are still reported.
 */
export async function verifyDomain(
  env: EmailEnv,
  actor: Actor,
  domainId: string,
  background: Background = noBackground,
): Promise<{ domain: Domain; records: DnsRecord[] }> {
  const { domain: row } = await domainContext(env, actor, domainId, 'read')
  // Also registers domains added before SES, and picks up SES's verification once its DKIM records are found.
  const domain = await syncSes(env, row).catch((err) => {
    console.error(`ses: syncing ${row.name} failed`, err)
    return row
  })
  // Until mail moves, the ownership TXT record comes first: it's all a Google Workspace import needs to start.
  const owner = domain.status === 'verified' ? [] : [ownershipRecord(domain)]
  const mail = storeRecords(env.AWS_SES_REGION, sesDkimRecords(domain))
  const expected = [...owner, ...mail]
  const records = isTestDomain(env, domain.name)
    ? expected.map((r) => ({ ...r, found: true }))
    : await checkRecords(expected, domain.name)
  const now = new Date().toISOString()
  const mailReady = records.every((r) => r.found || !r.required)
  if (domain.status !== 'verified' && mailReady) {
    const set = await domainsDb.setVerified(env.DB, domain.id, now).run()
    if (set.meta.changes) {
      const hours = Math.round(((Date.parse(now) - Date.parse(domain.created_at)) / 3_600_000) * 10) / 10
      track(env, background, actor.userId, domain.organization_id, 'Domain Verified', { domain: domain.name, hours_to_verify: hours })
    }
    return { domain: toDomain((await domainsDb.find(env.DB, domain.id))!), records }
  }
  if (!domain.owned_at && owner.length && records[0]!.found) {
    await domainsDb.setOwned(env.DB, domain.id, now).run()
    return { domain: toDomain((await domainsDb.find(env.DB, domain.id))!), records }
  }
  return { domain: toDomain(domain), records }
}

// ---------------------------------------------------------------------------------------------------------------
// Ownership: proving the domain is the organization's without moving its mail (a Google Workspace import needs
// this before the switch). A TXT record at the apex, like Google's and Microsoft's own domain checks.

const OWNERSHIP_PREFIX = 'xstate-verification='

export function ownershipRecord(domain: Pick<domainsDb.DomainRow, 'ownership_token'>): Omit<DnsRecord, 'found'> {
  return { type: 'TXT', name: '@', value: `${OWNERSHIP_PREFIX}${domain.ownership_token ?? ''}`, purpose: 'Ownership', required: false }
}

/**
 * Whether the organization has proven it owns the domain: its mail records are verified, or the ownership TXT
 * record was found before. Otherwise looks the record up now (and remembers a match), so adding the record and
 * trying again is enough. `.test` domains count as owned outside production.
 */
export async function checkOwnership(env: EmailEnv, domain: domainsDb.DomainRow): Promise<boolean> {
  if (domain.status === 'verified' || domain.owned_at) return true
  const found = isTestDomain(env, domain.name) || (!!domain.ownership_token && (await resolveTxt(domain.name).catch(() => [] as string[])).some((v) => v.trim() === ownershipRecord(domain).value))
  if (found) await domainsDb.setOwned(env.DB, domain.id, new Date().toISOString()).run()
  return found
}

/**
 * A signed Domain Connect link that adds the domain's mail records at its DNS provider in one click, or null when
 * one-click setup isn't available: turned off (DOMAIN_CONNECT_ENABLED), a .test domain, SES's DKIM tokens not
 * issued yet, or the provider doesn't support Domain Connect or hasn't onboarded our template.
 *
 * The DMARC record is applied only when the domain has none (see domainConnect.groupIds). `replacesMx` lists the
 * domain's current mail hosts, which approving replaces, so the app can say mail will stop going there.
 *
 * `redirectUri` is where the provider sends the browser back to (with `state` set to the domain id, and `error` if
 * it failed or was cancelled). It must be on one of APP_ORIGINS; anything else is dropped, because a signed link
 * would otherwise let anyone use our signature for an open redirect.
 */
export async function domainConnectUrl(
  env: EmailEnv & domainConnect.DomainConnectEnv & Pick<Env, 'APP_ORIGINS'>,
  actor: Actor,
  domainId: string,
  redirectUri?: string,
): Promise<{ applyUrl: string | null; provider: string | null; replacesMx: string[] }> {
  const { domain } = await domainContext(env, actor, domainId, 'read')
  const none = { applyUrl: null, provider: null, replacesMx: [] }
  if (!domainConnect.domainConnectEnabled(env, domain.name) || isTestDomain(env, domain.name)) return none
  // The published Domain Connect template still sets the old mail server's records, so until a template with SES's
  // records is published and onboarded by providers, every domain adds its records by hand.
  if (TEMPLATE_HAS_SES_RECORDS !== true) return none
  const tokens = domain.ses_dkim_tokens ? (JSON.parse(domain.ses_dkim_tokens) as string[]) : []
  if (tokens.length !== 3) return none

  try {
    const [txt] = await resolveTxt(`_domainconnect.${domain.name}`)
    if (!txt) return none
    const settings = await domainConnect.fetchSettings(txt, domain.name)
    if (!settings?.urlSyncUX || !(await domainConnect.supportsTemplate(settings))) return none
    const [dmarc, replacesMx] = await Promise.all([resolveTxt(`_dmarc.${domain.name}`), otherMxHosts(domain.name)])
    const redirect = redirectUri && allowedRedirect(env, redirectUri) ? redirectUri : undefined
    const applyUrl = await domainConnect.buildApplyUrl({
      urlSyncUX: settings.urlSyncUX,
      domain: domain.name,
      variables: { dkim1: tokens[0]!, dkim2: tokens[1]!, dkim3: tokens[2]! },
      groupIds: domainConnect.groupIds(dmarc),
      redirectUri: redirect,
      state: redirect && domain.id,
      keyHost: env.DOMAIN_CONNECT_KEY_HOST!,
      privateKey: env.DOMAIN_CONNECT_PRIVATE_KEY!,
    })
    return { applyUrl, provider: settings.providerDisplayName ?? settings.providerName ?? null, replacesMx }
  } catch (err) {
    // Discovery is a convenience: if the provider is unreachable, the records table still works.
    console.error(`domain connect: ${domain.name} failed`, err)
    return none
  }
}

/** Flip once the Domain Connect template (domain-connect.ts) carries SES's MX and SPF instead of the old server's. */
const TEMPLATE_HAS_SES_RECORDS: boolean = false

/** An http(s) URL whose origin is one of APP_ORIGINS. */
function allowedRedirect(env: Pick<Env, 'APP_ORIGINS'>, uri: string): boolean {
  try {
    const url = new URL(uri)
    return /^https?:$/.test(url.protocol) && env.APP_ORIGINS.split(',').includes(url.origin)
  } catch {
    return false
  }
}

/** Turns mail for a domain on or off without deleting anything. */
export async function setDomainEnabled(env: EmailEnv, actor: Actor, domainId: string, enabled: boolean): Promise<Domain> {
  const { domain } = await domainContext(env, actor, domainId, 'manage')
  await domainsDb.setEnabled(env.DB, domain.id, enabled, new Date().toISOString()).run()
  return toDomain((await domainsDb.find(env.DB, domain.id))!)
}

/** Removes a domain. Every mailbox and alias on it must be deleted first. */
export async function removeDomain(env: EmailEnv, actor: Actor, domainId: string): Promise<void> {
  const { domain, member } = await domainContext(env, actor, domainId, 'read')
  requireOrgPermission(member, 'domains.delete')

  const inUse = await addressesDb.countOnDomain(env.DB, domain.id)
  if (inUse) throw new EmailError('domain_not_empty', `Delete the ${inUse} address(es) on ${domain.name} first`, 409)

  if (ses.sesConfigured(env) && domain.ses_status) {
    await ses.deleteDomainIdentity(env, domain.name).catch((err) => console.error(`ses: removing ${domain.name} failed`, err))
  }
  await env.DB.batch([
    domainsDb.remove(env.DB, domain.id),
    membersDb.removeDomainFromPermissions(env.DB, domain.organization_id, domain.id),
  ])
}
