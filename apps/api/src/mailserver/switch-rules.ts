// The rules of a domain switch (docs/mailbox-store-plan.md, phase 4d) that don't need the network: whether public
// DNS shows only SES's MX, and whether the domain's mailboxes are ready to move. ./domain-switch.ts gathers the
// facts and runs the steps. Pure: `pnpm test` runs it under Node.

/** SES's receiving host for a region. */
export const sesInboundHost = (region: string) => `inbound-smtp.${region}.amazonaws.com`

/** Every MX host is SES's, and there is at least one: mail can no longer reach Stalwart by a current lookup. */
export function onlySesMx(hosts: string[], region: string): boolean {
  const ses = sesInboundHost(region)
  return hosts.length > 0 && hosts.every((h) => h.toLowerCase().replace(/\.$/, '') === ses)
}

/** What is known about one mailbox with an address on the domain. */
export type MailboxFacts = {
  address: string
  backend: 'stalwart' | 'store'
  storeMode: 'off' | 'shadow' | 'read'
  storeRaw: boolean
  /** The hourly comparison with Stalwart found no difference; null when it couldn't be made. */
  countsMatch: boolean | null
  rawMissing: number | null
  threadingLeft: number | null
  /** Addresses of this mailbox on other domains (they would be left behind). */
  otherDomainAddresses: string[]
}

export type Check = { check: string; ok: boolean; detail: string }

/** The checks `start` and `flip` require, in the order to show them. */
export function readiness(domain: { sending: string | null }, mailboxes: MailboxFacts[]): { ready: boolean; checks: Check[] } {
  const checks: Check[] = [
    { check: 'ses', ok: domain.sending === 'verified', detail: domain.sending === 'verified' ? 'verified with Amazon SES' : `Amazon SES: ${domain.sending ?? 'not registered'}` },
    { check: 'mailboxes', ok: mailboxes.length > 0, detail: `${mailboxes.length} mailbox${mailboxes.length === 1 ? '' : 'es'}` },
  ]
  for (const m of mailboxes) {
    if (m.backend === 'store') {
      checks.push({ check: `${m.address}: on the store`, ok: true, detail: 'already moved' })
      continue
    }
    checks.push(
      { check: `${m.address}: copy`, ok: m.storeMode === 'read', detail: m.storeMode === 'read' ? 'read mode' : `store_mode is ${m.storeMode}; it must be read` },
      { check: `${m.address}: counts`, ok: m.countsMatch === true, detail: m.countsMatch === null ? 'not checked' : m.countsMatch ? 'match Stalwart' : 'differ from Stalwart' },
      {
        check: `${m.address}: raw copies`,
        ok: m.storeRaw && m.rawMissing === 0,
        detail: !m.storeRaw ? 'raw copy is off' : m.rawMissing === null ? 'not checked' : `${m.rawMissing} missing`,
      },
      { check: `${m.address}: threading headers`, ok: m.threadingLeft === 0, detail: m.threadingLeft === null ? 'not checked' : `${m.threadingLeft} left` },
      {
        check: `${m.address}: other domains`,
        ok: m.otherDomainAddresses.length === 0,
        detail: m.otherDomainAddresses.length ? `also has ${m.otherDomainAddresses.join(', ')}` : 'none',
      },
    )
  }
  return { ready: checks.every((c) => c.ok), checks }
}
