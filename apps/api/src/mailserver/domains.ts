import * as addressesDb from '../db/addresses'
import * as domainsDb from '../db/domains'
import * as membersDb from '../db/members'
import { domainAccess, domainContext, isAdmin, loadMember, requireOrgPermission } from './access'
import { EmailError, withRollback } from './errors'
import { checkRecords, essentialRecords, isTestDomain, lookupDomain, resolveTxt, type DnsProvider, type DnsRecord } from './dns'
import * as domainConnect from './domain-connect'
import * as ses from './ses'
import * as stalwart from './stalwart/domains'
import { toDomain, type Actor, type Domain, type EmailEnv } from './types'
import { normalizeDomain } from './validation'

/** Adds a domain to Stalwart and to the organization. A plain member who adds it gets manage access to it. */
export async function addDomain(env: EmailEnv, actor: Actor, organizationId: string, name: string): Promise<Domain> {
  const member = await loadMember(env, organizationId, actor.userId)
  requireOrgPermission(member, 'domains.create')

  name = normalizeDomain(name)
  if (await domainsDb.nameTaken(env.DB, name)) throw new EmailError('domain_taken', `${name} is already added to xstate`, 409)

  const stalwartId = await stalwart.createDomain(env, name)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const writes = [domainsDb.insert(env.DB, { id, organizationId, name, stalwartId, createdBy: actor.userId, now })]
  if (!isAdmin(member) && domainAccess(member, id) !== 'manage') {
    const permissions = { ...member.permissions, domains: { ...member.permissions.domains, [id]: 'manage' as const } }
    writes.push(membersDb.setPermissions(env.DB, member.id, permissions, now))
  }
  await withRollback(
    () => env.DB.batch(writes),
    () => stalwart.destroyDomain(env, stalwartId),
  )

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

const sesDkimRecords = (domain: domainsDb.DomainRow) =>
  ses.dkimRecords(domain.ses_dkim_tokens ? (JSON.parse(domain.ses_dkim_tokens) as string[]) : [])

export async function getDomain(env: EmailEnv, actor: Actor, domainId: string): Promise<Domain> {
  const { domain } = await domainContext(env, actor, domainId, 'read')
  return toDomain(domain)
}

/** Domains in the organization that the actor can see. */
export async function listDomains(env: EmailEnv, actor: Actor, organizationId: string): Promise<Domain[]> {
  const member = await loadMember(env, organizationId, actor.userId)
  const rows = await domainsDb.listByOrganization(env.DB, organizationId)
  return rows.filter((d) => domainAccess(member, d.id)).map(toDomain)
}

/**
 * The DNS records the customer must add (MX, SPF, DKIM, DMARC, SRV, MTA-STS, autoconfig), as a zone file.
 * TLSA records are removed: they pin our certificate key, need DNSSEC, and break when certbot renews.
 */
export async function getDomainDnsRecords(env: EmailEnv, actor: Actor, domainId: string): Promise<string> {
  const { domain } = await domainContext(env, actor, domainId, 'read')
  const zone = await stalwart.getDnsZone(env, domain.stalwart_id)
  if (zone === undefined) throw new EmailError('domain_missing_on_mail_server', `${domain.name} is not on the mail server`, 502)
  const sesDkim = sesDkimRecords(domain)
  const lines = zone
    .split('\n')
    .filter((line) => !/\sTLSA\s/i.test(line))
    // With SES signing, Stalwart's own DKIM keys aren't used; SES's CNAMEs replace them.
    .filter((line) => !(sesDkim.length && /_domainkey\S*\s+IN\s+TXT/i.test(line)))
  for (const r of sesDkim) lines.push(`${r.name}.${domain.name}. IN CNAME ${r.value}.`)
  return lines.join('\n')
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
): Promise<{ domain: Domain; records: DnsRecord[] }> {
  const { domain: row } = await domainContext(env, actor, domainId, 'read')
  // Also registers domains added before SES, and picks up SES's verification once its DKIM records are found.
  const domain = await syncSes(env, row).catch((err) => {
    console.error(`ses: syncing ${row.name} failed`, err)
    return row
  })
  const zone = await stalwart.getDnsZone(env, domain.stalwart_id)
  if (zone === undefined) throw new EmailError('domain_missing_on_mail_server', `${domain.name} is not on the mail server`, 502)
  // Until mail moves, the ownership TXT record comes first: it's all a Google Workspace import needs to start.
  const owner = domain.status === 'verified' ? [] : [ownershipRecord(domain)]
  const expected = [...owner, ...essentialRecords(zone, domain.name, sesDkimRecords(domain))]
  const records = isTestDomain(env, domain.name)
    ? expected.map((r) => ({ ...r, found: true }))
    : await checkRecords(expected, domain.name)
  const now = new Date().toISOString()
  const mailReady = records.every((r) => r.found || !r.required)
  if (domain.status !== 'verified' && mailReady) {
    await domainsDb.setVerified(env.DB, domain.id, now).run()
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
 * `redirectUri` is where the provider sends the browser back to (with `state` set to the domain id, and `error` if
 * it failed or was cancelled). It must be on one of APP_ORIGINS; anything else is dropped, because a signed link
 * would otherwise let anyone use our signature for an open redirect.
 */
export async function domainConnectUrl(
  env: EmailEnv & domainConnect.DomainConnectEnv & Pick<Env, 'APP_ORIGINS'>,
  actor: Actor,
  domainId: string,
  redirectUri?: string,
): Promise<{ applyUrl: string | null; provider: string | null }> {
  const { domain } = await domainContext(env, actor, domainId, 'read')
  const none = { applyUrl: null, provider: null }
  if (!domainConnect.domainConnectEnabled(env) || isTestDomain(env, domain.name)) return none
  const tokens = domain.ses_dkim_tokens ? (JSON.parse(domain.ses_dkim_tokens) as string[]) : []
  if (tokens.length !== 3) return none

  try {
    const [txt] = await resolveTxt(`_domainconnect.${domain.name}`)
    if (!txt) return none
    const settings = await domainConnect.fetchSettings(txt, domain.name)
    if (!settings?.urlSyncUX || !(await domainConnect.supportsTemplate(settings))) return none
    const redirect = redirectUri && allowedRedirect(env, redirectUri) ? redirectUri : undefined
    const applyUrl = await domainConnect.buildApplyUrl({
      urlSyncUX: settings.urlSyncUX,
      domain: domain.name,
      variables: { dkim1: tokens[0]!, dkim2: tokens[1]!, dkim3: tokens[2]! },
      redirectUri: redirect,
      state: redirect && domain.id,
      keyHost: env.DOMAIN_CONNECT_KEY_HOST!,
      privateKey: env.DOMAIN_CONNECT_PRIVATE_KEY!,
    })
    return { applyUrl, provider: settings.providerDisplayName ?? settings.providerName ?? null }
  } catch (err) {
    // Discovery is a convenience: if the provider is unreachable, the records table still works.
    console.error(`domain connect: ${domain.name} failed`, err)
    return none
  }
}

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
  await stalwart.setDomainEnabled(env, domain.stalwart_id, enabled)
  await withRollback(
    () => domainsDb.setEnabled(env.DB, domain.id, enabled, new Date().toISOString()).run(),
    () => stalwart.setDomainEnabled(env, domain.stalwart_id, domain.enabled === 1),
  )
  return toDomain((await domainsDb.find(env.DB, domain.id))!)
}

/** Removes a domain. Every mailbox and alias on it must be deleted first. */
export async function removeDomain(env: EmailEnv, actor: Actor, domainId: string): Promise<void> {
  const { domain, member } = await domainContext(env, actor, domainId, 'read')
  requireOrgPermission(member, 'domains.delete')

  const inUse = await addressesDb.countOnDomain(env.DB, domain.id)
  if (inUse) throw new EmailError('domain_not_empty', `Delete the ${inUse} address(es) on ${domain.name} first`, 409)

  await stalwart.destroyDomain(env, domain.stalwart_id)
  if (ses.sesConfigured(env) && domain.ses_status) {
    await ses.deleteDomainIdentity(env, domain.name).catch((err) => console.error(`ses: removing ${domain.name} failed`, err))
  }
  await env.DB.batch([
    domainsDb.remove(env.DB, domain.id),
    membersDb.removeDomainFromPermissions(env.DB, domain.organization_id, domain.id),
  ])
}
