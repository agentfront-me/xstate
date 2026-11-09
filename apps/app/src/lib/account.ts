// The signed-in account: user, organization, domains, mailboxes and DNS records of pending domains. Kept in the
// React Query cache under ['account']. In demo mode (/app/?demo, no sign-in) everything comes from sample.ts and
// changes stay in memory. Mail is loaded separately (src/mail/data.ts).

import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, session } from './core'
import * as sample from './sample'
import type { DnsRecord, Domain, Mailbox, Org, User } from './types'

export type Account = {
  mode: 'live' | 'demo'
  user: User
  org: Org
  domains: Domain[]
  mailboxes: Mailbox[]
  /** DNS records per pending domain id, from the last verify call. */
  records: Record<string, DnsRecord[]>
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
})

const KEY = ['account'] as const

/** Demo mode (/app/?demo) is fixed for the page's lifetime, signed in or not. */
export const isDemo = () => new URLSearchParams(location.search).has('demo')

/** Loads the account. Returns null when there is no session and no demo flag (send people to sign in). */
async function loadAccount(): Promise<Account | null> {
  if (!isDemo() && !session()) return null
  if (isDemo()) {
    return {
      mode: 'demo',
      user: { ...sample.sampleUser },
      org: { ...sample.sampleOrg },
      domains: sample.sampleDomains.map((d) => ({ ...d })),
      mailboxes: sample.sampleMailboxes.map((m) => ({ ...m })),
      records: { dom_3: sample.sampleRecords },
    }
  }
  const me = await api<{ user: User; organizations: Org[] }>('GET', '/auth/me')
  const org = me.organizations.find((o) => o.role === 'owner') ?? me.organizations[0]
  if (!org) throw new Error('Your account has no organization.')
  const { domains, mailboxes } = await fetchDomains(org.id)
  const account: Account = { mode: 'live', user: me.user, org, domains, mailboxes, records: {} }
  await checkPending(account)
  return account
}

async function fetchDomains(orgId: string) {
  const [{ domains }, { mailboxes }] = await Promise.all([
    api<{ domains: Domain[] }>('GET', `/email/orgs/${orgId}/domains`),
    api<{ mailboxes: Mailbox[] }>('GET', `/email/orgs/${orgId}/mailboxes`),
  ])
  return { domains, mailboxes }
}

/** Runs a DNS check on every pending domain, filling in `records` (and verifying any that are ready). */
async function checkPending(account: Account) {
  await Promise.all(
    account.domains
      .filter((d) => d.status !== 'verified')
      .map(async (d) => {
        const result = await api<{ domain: Domain; records: DnsRecord[] }>('POST', `/email/domains/${d.id}/verify`).catch(() => null)
        if (!result) return
        account.records[d.id] = result.records
        account.domains = account.domains.map((x) => (x.id === d.id ? result.domain : x))
      }),
  )
}

/** The account query. Loading and errors are handled once by the app shell, so screens can use useAccount(). */
export function useAccountQuery() {
  return useQuery({ queryKey: KEY, queryFn: loadAccount, staleTime: Infinity })
}

/** The loaded account. Only for components rendered inside the shell, after it has loaded. */
export function useAccount(): Account {
  const { data } = useQuery({ queryKey: KEY, queryFn: loadAccount, staleTime: Infinity })
  if (!data) throw new Error('useAccount() used before the account loaded')
  return data
}

/** Owners and admins run the organization: members, domains, keys, imports. */
export const isOrgAdmin = (org: Pick<Org, 'role'>) => org.role === 'owner' || org.role === 'admin'

export const mailboxesOf = (account: Account, domainId: string) => account.mailboxes.filter((m) => m.domainId === domainId)

// ---------------------------------------------------------------------------------------------------------------
// Changes. Each updates the cached account, so every screen that shows it re-renders.

function update(client: QueryClient, fn: (a: Account) => Account) {
  client.setQueryData<Account | null>(KEY, (a) => (a ? fn(a) : a))
}

const current = (client: QueryClient) => {
  const a = client.getQueryData<Account | null>(KEY)
  if (!a) throw new Error('The account is not loaded')
  return a
}

/** Checks a domain's DNS. The API verifies it once every required record is found. */
export async function verifyDomain(client: QueryClient, domainId: string): Promise<{ domain?: Domain; records: DnsRecord[] }> {
  const a = current(client)
  if (a.mode === 'demo') return { domain: a.domains.find((d) => d.id === domainId), records: a.records[domainId] ?? [] }
  const result = await api<{ domain: Domain; records: DnsRecord[] }>('POST', `/email/domains/${domainId}/verify`)
  update(client, (x) => ({
    ...x,
    records: { ...x.records, [domainId]: result.records },
    domains: x.domains.map((d) => (d.id === domainId ? result.domain : d)),
  }))
  return result
}

export async function addDomain(client: QueryClient, name: string): Promise<Domain> {
  const a = current(client)
  if (a.mode === 'demo') {
    const domain: Domain = { id: `dom_${Date.now()}`, name, status: 'pending', enabled: true }
    update(client, (x) => ({ ...x, domains: [...x.domains, domain], records: { ...x.records, [domain.id]: sample.sampleRecords } }))
    return domain
  }
  const { domain } = await api<{ domain: Domain }>('POST', `/email/orgs/${a.org.id}/domains`, { name })
  update(client, (x) => ({ ...x, domains: [...x.domains, domain] }))
  await verifyDomain(client, domain.id).catch(() => null)
  return domain
}

export async function removeDomain(client: QueryClient, domainId: string): Promise<void> {
  if (current(client).mode === 'live') await api('DELETE', `/email/domains/${domainId}`)
  update(client, (x) => {
    const records = { ...x.records }
    delete records[domainId]
    return {
      ...x,
      domains: x.domains.filter((d) => d.id !== domainId),
      mailboxes: x.mailboxes.filter((m) => m.domainId !== domainId),
      records,
    }
  })
}

export { useQueryClient }
