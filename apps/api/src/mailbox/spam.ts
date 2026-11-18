// Inbox or Junk for mail received into a store-held mailbox (docs/mailbox-store-plan.md, phase 2 step 4b: spam
// layers 2 and 3). One decision from SES's verdicts, the message's headers and what the mailbox and organization
// know about the sender, with the reasons, which are kept with the message. Pure: no runtime imports, so `pnpm test`
// runs it directly under Node.

/** Junk at this score or more (step 4 of the order). */
export const JUNK_SCORE = 5

export type SpamInput = {
  /** SES's verdicts, uppercase ('PASS', 'FAIL', 'GRAY', …; '' when missing). */
  ses: { spam: string; spf: string; dkim: string; dmarc: string }
  /** The sender domain's DMARC policy, which SES reports when DMARC fails: 'none', 'quarantine' or 'reject'. */
  dmarcPolicy: string | null
  from: { name: string | null; email: string } | null
  replyTo: string[]
  /** This mailbox's verdict on the sender: someone moved their mail to Junk, or out of it. */
  senderVerdict: 'junk' | 'notjunk' | null
  /** The mailbox has written to the sender, or the sender is one of the organization's contacts. */
  known: boolean
  /** The organization's own domains, and the display names of its members and mailboxes. */
  orgDomains: string[]
  orgNames: string[]
}

export type SpamDecision = { folder: 'inbox' | 'junk'; score: number; reasons: string[] }

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase()
const squash = (name: string) => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export function decideSpam(m: SpamInput): SpamDecision {
  // 1. The mailbox's own word on this sender.
  if (m.senderVerdict === 'notjunk') return { folder: 'inbox', score: 0, reasons: ['Marked not junk before'] }
  if (m.senderVerdict === 'junk') return { folder: 'junk', score: 0, reasons: ['Marked junk before'] }

  // 2. A domain that asks for failing mail to be refused or quarantined: this is what forged mail from a known
  // sender looks like, so knowing the sender doesn't rescue it.
  const dmarcFail = m.ses.dmarc === 'FAIL'
  const policy = (m.dmarcPolicy ?? '').toLowerCase()
  if (dmarcFail && (policy === 'reject' || policy === 'quarantine')) {
    return { folder: 'junk', score: 0, reasons: [`Failed DMARC; ${domainOf(m.from?.email ?? '')} asks for ${policy}`] }
  }

  // 3. Someone the mailbox knows, and nothing says the message is forged.
  if (m.known && !dmarcFail) return { folder: 'inbox', score: 0, reasons: ['Known sender'] }

  // 4. A score from the signals left.
  const reasons: string[] = []
  let score = 0
  const add = (points: number, reason: string) => {
    score += points
    reasons.push(`${reason} (+${points})`)
  }
  if (m.ses.spam === 'FAIL') add(5, 'Amazon SES spam check failed')
  const fromDomain = m.from ? domainOf(m.from.email) : ''
  const outside = !!m.from && !m.orgDomains.map((d) => d.toLowerCase()).includes(fromDomain)
  const name = m.from?.name ? squash(m.from.name) : ''
  if (outside && name.length >= 3 && m.orgNames.some((n) => squash(n) === name)) add(5, `Uses the name "${m.from!.name}" from outside the organization`)
  if (m.ses.spf === 'FAIL' && m.ses.dkim === 'FAIL') add(3, 'SPF and DKIM both failed')
  if (dmarcFail) add(2, 'Failed DMARC')
  if (fromDomain && m.replyTo.some((r) => domainOf(r) !== fromDomain)) add(1, 'Reply-To goes to another domain')
  return { folder: score >= JUNK_SCORE ? 'junk' : 'inbox', score, reasons }
}
