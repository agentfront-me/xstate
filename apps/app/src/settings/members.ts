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

export async function resendInvite(client: QueryClient, orgId: string, memberId: string) {
  const result = await api<{ member: OrgMember; email: Delivery }>('POST', `/members/${memberId}/invite`)
  put(client, orgId, result.member)
  return result
}

export async function setMemberRole(client: QueryClient, orgId: string, memberId: string, role: 'admin' | 'member') {
  const { member } = await api<{ member: OrgMember }>('PATCH', `/members/${memberId}`, { role })
  put(client, orgId, member)
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
