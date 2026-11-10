// The signed-in account: the user, the organization they work in, its domains and its mailboxes. Cached under ['account'].

import { QueryClient, useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { Domain, Mailbox, Org, User } from './types'

export type Account = { user: User; org: Org; domains: Domain[]; mailboxes: Mailbox[] }

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

async function loadAccount(): Promise<Account> {
  const me = await api<{ user: User; organizations: Org[] }>('GET', '/auth/me')
  const org = me.organizations.find((o) => o.role === 'owner') ?? me.organizations[0]
  if (!org) throw new Error('Your account has no organization.')
  const [{ domains }, { mailboxes }] = await Promise.all([
    api<{ domains: Domain[] }>('GET', `/email/orgs/${org.id}/domains`),
    api<{ mailboxes: Mailbox[] }>('GET', `/email/orgs/${org.id}/mailboxes`),
  ])
  return { user: me.user, org, domains, mailboxes }
}

export const useAccountQuery = () => useQuery({ queryKey: ['account'], queryFn: loadAccount, staleTime: Infinity })

/** The loaded account. Only for screens inside the signed-in layout, which waits for it. */
export function useAccount(): Account {
  const { data } = useAccountQuery()
  if (!data) throw new Error('useAccount() used before the account loaded')
  return data
}

/** Owners and admins run the organization: members, domains and AI provider keys. */
export const canManage = (org: Org) => org.role === 'owner' || org.role === 'admin'
