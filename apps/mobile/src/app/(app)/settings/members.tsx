// Everyone in the organization and their role. View only.

import { useQuery } from '@tanstack/react-query'
import { useAccount } from '@/lib/account'
import { ListScreen, membersQuery } from '@/sections/workspace'
import { c } from '@/ui/theme'

const ROLE = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const

export default function MembersScreen() {
  const { org } = useAccount()
  const members = useQuery(membersQuery(org.id))
  return (
    <ListScreen
      title="Members"
      items={members.data?.map((m) => ({
        id: m.id,
        title: m.name ?? m.email,
        sub: m.name ? m.email : undefined,
        value: m.status === 'invited' ? 'Invited' : ROLE[m.role],
        color: m.status === 'invited' ? c.warn : undefined,
      }))}
      note="Invite and change roles on desktop."
      empty="No members."
      error={members.error}
      refreshing={members.isRefetching}
      onRefresh={() => void members.refetch()}
    />
  )
}
