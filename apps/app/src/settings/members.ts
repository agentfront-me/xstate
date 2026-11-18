// Members of the organization from the API (apps/api/src/members/service.ts), cached under ['members', orgId].

import { useQuery, type QueryClient } from '@tanstack/react-query'
import { api } from '../lib/core'

export type MemberRole = 'owner' | 'admin' | 'member'

export type OrgMember = {
  id: string
  userId: string
  name: string | null
  email: string
  role: MemberRole
  status: 'invited' | 'active'
  you: boolean
  joinedAt: string
  invite: { sentAt: string | null; expiresAt: string; invitedBy: string | null } | null
  /** Where invites and reset links go. Only shown for yourself, or to people who manage members. */
  recoveryEmail: string | null
  /** Their own mailbox: every address, the primary one (their sign-in) first. */
  mailbox: MemberMailbox | null
}

export type MemberMailbox = {
  id: string
  /** 'store': on the new mail system, where the primary address can be changed. */
  backend: 'stalwart' | 'store'
  addresses: { id: string; address: string; domainId: string; primary: boolean }[]
}

export type NewAddress = { localPart: string; domainId: string }

export type NewMember = {
  name: string
  role: 'admin' | 'member'
  mailbox: NewAddress
  alsoAt: NewAddress[]
  signIn: 'invite' | 'password'
  recoveryEmail?: string
}

/** Whether the invite email went out. Outside production the API also returns the link (local mail goes nowhere). */
export type Delivery = { sent: boolean; reason?: string; inviteUrl?: string }

const key = (orgId: string) => ['members', orgId] as const

export function useMembers(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: key(orgId),
    queryFn: async () => (await api<{ members: OrgMember[] }>('GET', `/members/orgs/${orgId}`)).members,
    enabled,
  })
}

function put(client: QueryClient, orgId: string, member: OrgMember) {
  client.setQueryData<OrgMember[]>(key(orgId), (list = []) =>
    list.some((m) => m.id === member.id) ? list.map((m) => (m.id === member.id ? member : m)) : [...list, member],
  )
}

export async function inviteMember(client: QueryClient, orgId: string, input: { email: string; role: 'admin' | 'member' }) {
  const result = await api<{ member: OrgMember; email: Delivery }>('POST', `/members/orgs/${orgId}`, input)
  put(client, orgId, result.member)
  return result
}

/** Adds someone with their own mailbox. `password` is the temporary password, shown once. */
export async function addMember(client: QueryClient, orgId: string, input: NewMember) {
  const result = await api<{ member: OrgMember; email: Delivery | null; password?: string }>('POST', `/members/orgs/${orgId}/add`, input)
  put(client, orgId, result.member)
  return result
}

export async function updateMember(client: QueryClient, orgId: string, memberId: string, changes: { name?: string; recoveryEmail?: string | null }) {
  const { member } = await api<{ member: OrgMember }>('PATCH', `/members/${memberId}`, changes)
  put(client, orgId, member)
  return member
}

export async function setPrimaryAddress(client: QueryClient, orgId: string, memberId: string, addressId: string) {
  const { member } = await api<{ member: OrgMember }>('POST', `/members/${memberId}/addresses/${addressId}/primary`)
  put(client, orgId, member)
}

/** Adds or removes an extra address on the member's mailbox, then reloads the members. */
export async function addMemberAddress(client: QueryClient, orgId: string, mailboxId: string, address: NewAddress) {
  await api('POST', `/email/mailboxes/${mailboxId}/aliases`, address)
  await client.invalidateQueries({ queryKey: key(orgId) })
}

export async function removeMemberAddress(client: QueryClient, orgId: string, mailboxId: string, address: string) {
  await api('DELETE', `/email/mailboxes/${mailboxId}/aliases/${encodeURIComponent(address)}`)
  await client.invalidateQueries({ queryKey: key(orgId) })
}

/** A new temporary password for the member, shown once. They choose their own at their next sign-in. */
export async function setTemporaryPassword(client: QueryClient, orgId: string, memberId: string) {
  const result = await api<{ password: string }>('POST', `/members/${memberId}/password`)
  // Someone still invited joins with it: reload so they show as a member.
  await client.invalidateQueries({ queryKey: key(orgId) })
  return result.password
}

/** Emails the member a link to choose a new password. `to` is where it went. */
export async function sendPasswordReset(memberId: string) {
  return (await api<{ email: Delivery & { to: string } }>('POST', `/members/${memberId}/password-reset`)).email
}

export async function resendInvite(client: QueryClient, orgId: string, memberId: string) {
  const result = await api<{ member: OrgMember; email: Delivery }>('POST', `/members/${memberId}/invite`)
  put(client, orgId, result.member)
  return result
}

export async function setMemberRole(client: QueryClient, orgId: string, memberId: string, role: 'admin' | 'member') {
  const { member } = await api<{ member: OrgMember }>('PATCH', `/members/${memberId}`, { role })
  put(client, orgId, member)
  return member
}

export async function removeMember(client: QueryClient, orgId: string, memberId: string) {
  await api('DELETE', `/members/${memberId}`)
  client.setQueryData<OrgMember[]>(key(orgId), (list = []) => list.filter((m) => m.id !== memberId))
}

export function membersSub(members: OrgMember[]): string {
  const invited = members.filter((m) => m.status === 'invited').length
  const n = members.length - invited
  return `${n} ${n === 1 ? 'member' : 'members'}${invited ? ` · ${invited} invited` : ''}`
}
