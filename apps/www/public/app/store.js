// What the dashboard knows. `mode` is 'live' when signed in (account, domains and mailboxes come from the API) or
// 'demo' at /app/?demo without a session (everything from sample.js). Views read `store` and call `emit()` after
// changing it; the shell re-renders on 'change'.

import { api, session } from './core.js'
import * as sample from './sample.js'

export const store = {
  mode: 'demo',
  user: null,
  org: null,
  domains: [],
  mailboxes: [],
  /** DNS records per pending domain id, from the last verify call. */
  records: {},
  messages: [],
  members: [],
  secrets: [],
  billing: null,
  integrations: [],
}

const listeners = new Set()
export const onChange = (fn) => listeners.add(fn)
export const emit = () => listeners.forEach((fn) => fn())

export const isDemo = () => store.mode === 'demo'

/** Loads everything. Returns false when there is no session and no demo flag (the caller sends people to sign in). */
export async function load() {
  const demo = new URLSearchParams(location.search).has('demo')
  // Data with no API yet: the same in both modes until the endpoints exist.
  store.secrets = sample.sampleSecrets.map((s) => ({ ...s }))
  store.billing = sample.sampleBilling
  store.integrations = sample.sampleIntegrations.map((i) => ({ ...i }))

  if (!session() || demo) {
    if (!demo) return false
    store.mode = 'demo'
    store.user = { ...sample.sampleUser }
    store.org = { ...sample.sampleOrg }
    store.domains = sample.sampleDomains.map((d) => ({ ...d }))
    store.mailboxes = sample.sampleMailboxes.map((m) => ({ ...m }))
    store.records = { dom_3: sample.sampleRecords }
    store.messages = sample.sampleMessages()
    store.members = sample.sampleMembers.map((m) => ({ ...m }))
    return true
  }

  store.mode = 'live'
  const me = await api('GET', '/auth/me')
  store.user = me.user
  store.org = me.organizations.find((o) => o.role === 'owner') ?? me.organizations[0]
  await refreshDomains()
  // No message API yet: a signed-in inbox starts empty rather than showing someone else's mail.
  store.messages = []
  store.members = []
  return true
}

/** Re-reads domains and mailboxes, and the DNS records of any pending domain. */
export async function refreshDomains() {
  if (isDemo()) return
  const [{ domains }, { mailboxes }] = await Promise.all([
    api('GET', `/email/orgs/${store.org.id}/domains`),
    api('GET', `/email/orgs/${store.org.id}/mailboxes`),
  ])
  store.domains = domains
  store.mailboxes = mailboxes
  await Promise.all(domains.filter((d) => d.status !== 'verified').map((d) => verifyDomain(d.id).catch(() => null)))
}

/** Checks a domain's DNS. Verifies it once every required record is found. */
export async function verifyDomain(domainId) {
  if (isDemo()) return { records: store.records[domainId] ?? [] }
  const result = await api('POST', `/email/domains/${domainId}/verify`)
  store.records[domainId] = result.records
  const i = store.domains.findIndex((d) => d.id === domainId)
  if (i >= 0) store.domains[i] = result.domain
  return result
}

export async function addDomain(name) {
  if (isDemo()) {
    const domain = { id: `dom_${Date.now()}`, name, status: 'pending', enabled: true }
    store.domains.push(domain)
    store.records[domain.id] = sample.sampleRecords
    return domain
  }
  const { domain } = await api('POST', `/email/orgs/${store.org.id}/domains`, { name })
  store.domains.push(domain)
  await verifyDomain(domain.id).catch(() => null)
  return domain
}

export async function removeDomain(domainId) {
  if (!isDemo()) await api('DELETE', `/email/domains/${domainId}`)
  store.domains = store.domains.filter((d) => d.id !== domainId)
  store.mailboxes = store.mailboxes.filter((m) => m.domainId !== domainId)
  delete store.records[domainId]
}

export const mailboxesOf = (domainId) => store.mailboxes.filter((m) => m.domainId === domainId)
