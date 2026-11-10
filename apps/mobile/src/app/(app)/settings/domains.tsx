// The organization's domains and whether each is verified. View only.

import { useAccountQuery } from '@/lib/account'
import { ListScreen } from '@/sections/workspace'
import { c } from '@/ui/theme'

export default function DomainsScreen() {
  const account = useAccountQuery()
  return (
    <ListScreen
      title="Domains"
      items={account.data?.domains.map((d) => ({
        id: d.id,
        title: d.name,
        sub: d.status === 'verified' ? (d.enabled ? 'Mail active' : 'Mail turned off') : 'Waiting for DNS records',
        value: d.status === 'verified' ? 'Verified' : 'Pending',
        color: d.status === 'verified' ? undefined : c.warn,
      }))}
      note="Add domains and DNS records on desktop."
      empty="No domains yet."
      refreshing={account.isRefetching}
      onRefresh={() => void account.refetch()}
    />
  )
}
