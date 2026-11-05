import * as addressesDb from '../db/addresses'
import * as domainsDb from '../db/domains'
import * as membersDb from '../db/members'
import { domainAccess, domainContext, isAdmin, loadMember, requireOrgPermission } from './access'
import { EmailError, withRollback } from './errors'
import { checkRecords, essentialRecords, lookupDomain, type DnsProvider, type DnsRecord } from './dns'
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

  return toDomain((await domainsDb.find(env.DB, id))!)
}

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
  return zone
    .split('\n')
    .filter((line) => !/\sTLSA\s/i.test(line))
    .join('\n')
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
  const [lookup, taken] = await Promise.all([lookupDomain(name), domainsDb.nameTaken(env.DB, name)])
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
  const { domain } = await domainContext(env, actor, domainId, 'read')
  const records = await checkRecords(essentialRecords(await getDomainDnsRecords(env, actor, domainId), domain.name), domain.name)
  if (domain.status !== 'verified' && records.every((r) => r.found || !r.required)) {
    await domainsDb.setVerified(env.DB, domain.id, new Date().toISOString()).run()
    return { domain: toDomain((await domainsDb.find(env.DB, domain.id))!), records }
  }
  return { domain: toDomain(domain), records }
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
  await env.DB.batch([
    domainsDb.remove(env.DB, domain.id),
    membersDb.removeDomainFromPermissions(env.DB, domain.organization_id, domain.id),
  ])
}
