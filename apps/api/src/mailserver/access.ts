// Who may do what: roles, org permissions, domain access and mailbox ownership.

import * as addressesDb from '../db/addresses'
import * as domainsDb from '../db/domains'
import * as mailboxAccessDb from '../db/mailbox-access'
import * as mailboxesDb from '../db/mailboxes'
import * as membersDb from '../db/members'
import type { DomainAccess, Member, OrgPermission } from '../db/members'
import { EmailError, forbidden, notFound } from './errors'
import type { Actor, EmailEnv } from './types'

export async function loadMember(env: EmailEnv, organizationId: string, userId: string): Promise<Member> {
  const member = await membersDb.find(env.DB, organizationId, userId)
  // Same answer as a missing organization, so non-members can't probe which organizations exist.
  if (!member) throw notFound('organization')
  return member
}

export function isAdmin(member: Member): boolean {
  return member.role === 'owner' || member.role === 'admin'
}

export function requireOrgPermission(member: Member, permission: OrgPermission): void {
  if (!isAdmin(member) && !member.permissions.org.includes(permission)) {
    throw forbidden(`Missing permission ${permission}`)
  }
}

export function domainAccess(member: Member, domainId: string): DomainAccess | null {
  if (isAdmin(member)) return 'manage'
  return member.permissions.domains[domainId] ?? member.permissions.domains['*'] ?? null
}

/** Loads a domain and checks the actor can read or manage it. */
export async function domainContext(env: EmailEnv, actor: Actor, domainId: string, need: DomainAccess) {
  const domain = await domainsDb.find(env.DB, domainId)
  if (!domain) throw notFound('domain')
  const member = await loadMember(env, domain.organization_id, actor.userId)
  const access = domainAccess(member, domain.id)
  if (!access) throw notFound('domain')
  if (need === 'manage' && access !== 'manage') throw forbidden(`You can't manage ${domain.name}`)
  return { domain, member }
}

/**
 * Loads a mailbox and checks the actor may act on it.
 * 'read': can read its domain or has any access. 'owner': owns it or manages its domain. 'manage': manages its domain.
 */
export async function mailboxContext(env: EmailEnv, actor: Actor, mailboxId: string, need: 'read' | 'owner' | 'manage') {
  const mailbox = await mailboxesDb.find(env.DB, mailboxId)
  if (!mailbox) throw notFound('mailbox')
  const member = await loadMember(env, mailbox.organization_id, actor.userId)
  const access = domainAccess(member, mailbox.domain_id)
  const own = (await mailboxAccessDb.find(env.DB, mailbox.id, member.id))?.access

  if (!access && !own) throw notFound('mailbox')
  const allowed = need === 'read' || access === 'manage' || (need === 'owner' && own === 'owner')
  if (!allowed) throw forbidden("You can't change this mailbox")
  return { mailbox, member }
}

export async function requireMemberInOrg(env: EmailEnv, memberId: string, organizationId: string): Promise<void> {
  if (!(await membersDb.exists(env.DB, memberId, organizationId))) throw notFound('member')
}

export async function requireAddressFree(env: EmailEnv, address: string): Promise<void> {
  if (await addressesDb.taken(env.DB, address)) throw new EmailError('address_taken', `${address} is already in use`, 409)
}
