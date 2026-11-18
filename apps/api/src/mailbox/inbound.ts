// The pure parts of receiving mail through SES (docs/mailbox-store-plan.md, phase 2 step 1): reading SES's
// notification into a queue job, ids for new mail, and the keys conversations are matched on. No runtime imports,
// so `pnpm test` runs this file directly under Node. The consumer is ./receive.ts.

/** SES's verdicts on a received message: 'PASS', 'FAIL', 'GRAY' or 'PROCESSING_FAILED' ('' when missing). */
export type Verdicts = {
  spam: string
  virus: string
  spf: string
  dkim: string
  dmarc: string
  /** The sender domain's DMARC policy ('none', 'quarantine', 'reject'), which SES reports when DMARC fails; '' otherwise. */
  dmarcPolicy?: string
}

/** One received message, as the webhook queues it for the consumer. */
export type InboundJob = {
  /** SES's id for the message: what a retried or repeated delivery is recognized by. */
  sesId: string
  /** Where SES saved the raw message (the S3 action). Null when the notification carried it instead. */
  bucket: string | null
  key: string | null
  /** The raw message, base64, when the notification carried it (SNS action, small messages; local dev). */
  content?: string
  /** The envelope recipients, lowercase: who the message is for, Bcc included. */
  recipients: string[]
  verdicts: Verdicts
  /** When SES received it, ISO without milliseconds. */
  receivedAt: string
  /** The envelope sender (SMTP MAIL FROM), for the delivery log; may differ from the From header, or be empty. */
  source?: string | null
  /** Moved from the mailbox's old Stalwart account, not received through SES (mailbox/stalwart-sweep.ts). */
  sweptFromStalwart?: string
}

type Verdict = { status?: string } | undefined
type SesReceived = {
  notificationType?: string
  receipt?: {
    timestamp?: string
    recipients?: string[]
    spamVerdict?: Verdict
    virusVerdict?: Verdict
    spfVerdict?: Verdict
    dkimVerdict?: Verdict
    dmarcVerdict?: Verdict
    dmarcPolicy?: string
    action?: { type?: string; bucketName?: string; objectKey?: string; encoding?: string }
  }
  mail?: { messageId?: string; timestamp?: string; source?: string }
  content?: string
}

/** Queue messages hold 128 KB; a raw message carried in the notification is only passed on below this. */
const MAX_CARRIED_BYTES = 96 * 1024

/** The queue job for an SES "Received" notification, or null for anything else. */
export function inboundJob(notification: unknown): InboundJob | null {
  const n = notification as SesReceived
  if (n?.notificationType !== 'Received' || !n.mail?.messageId || !n.receipt) return null
  const r = n.receipt
  const status = (v: Verdict) => (v?.status ?? '').toUpperCase()
  const time = Date.parse(r.timestamp ?? n.mail.timestamp ?? '')
  const job: InboundJob = {
    sesId: n.mail.messageId,
    bucket: r.action?.type === 'S3' ? (r.action.bucketName ?? null) : null,
    key: r.action?.type === 'S3' ? (r.action.objectKey ?? null) : null,
    recipients: [...new Set((r.recipients ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean))],
    verdicts: {
      spam: status(r.spamVerdict),
      virus: status(r.virusVerdict),
      spf: status(r.spfVerdict),
      dkim: status(r.dkimVerdict),
      dmarc: status(r.dmarcVerdict),
      dmarcPolicy: (r.dmarcPolicy ?? '').toLowerCase(),
    },
    receivedAt: new Date(Number.isNaN(time) ? Date.now() : time).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: sourceAddress(n.mail.source),
  }
  if (n.content) {
    // The SNS action sends the message as UTF-8 text or base64; the job always carries base64.
    const base64 = r.action?.encoding?.toUpperCase() === 'BASE64' ? n.content.replace(/\s+/g, '') : utf8ToBase64(n.content)
    if (base64.length <= MAX_CARRIED_BYTES) job.content = base64
  }
  return job
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * A ULID: 26 characters, uppercase, sorting by creation time. New messages, threads and folders get these. Stalwart's
 * ids are lowercase letters and digits, so the two can never be equal, and mail copied from Stalwart keeps its ids.
 */
export function ulid(now = Date.now(), random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time
    t = Math.floor(t / 32)
  }
  const bytes = random(16)
  let rest = ''
  for (let i = 0; i < 16; i++) rest += CROCKFORD[bytes[i]! % 32]
  return time + rest
}

/** Reply and forward prefixes in the languages mail commonly arrives in, repeated or numbered ("Re[2]:"). */
const PREFIX = /^\s*(?:\[[^\]]{1,40}\]\s*)?(?:(?:re|fwd?|aw|wg|sv|vs|antw|rif|tr|r)(?:\s*\[\d+\])?\s*:\s*)+/i

/** A subject as conversations are matched on it: without reply and forward prefixes, spaces collapsed, lowercase. */
export function subjectKey(subject: string): string {
  let s = subject
  for (let i = 0; i < 5; i++) {
    const next = s.replace(PREFIX, '')
    if (next === s) break
    s = next
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** The Message-IDs in a header (In-Reply-To, References), without angle brackets, in order. */
export function messageIds(header: string | null | undefined): string[] {
  if (!header) return []
  const bracketed = [...header.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!)
  return bracketed.length ? bracketed : header.split(/\s+/).filter((t) => t.includes('@'))
}

/** A short preview from a message's text: whitespace collapsed, cut to `max` characters. */
export function previewOf(text: string, max = 300): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

/** When a ULID was made, in milliseconds since 1970; NaN for anything else. */
export function ulidTime(id: string): number {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return NaN
  let t = 0
  for (const ch of id.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(ch)
  return t
}

/**
 * The bare address in an SES `mail.source`. For a raw send without FromEmailAddress (mailbox/ses-send.ts keeps the
 * display name that way) SES reports the From header as it is, `99events <hello@99events.com>`; otherwise, and for
 * received mail, it is the envelope sender. Lowercased; null when there is none.
 */
export function sourceAddress(source: string | null | undefined): string | null {
  if (!source) return null
  const bracketed = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(source)
  const address = (bracketed?.[1] ?? source).trim().toLowerCase()
  return address || null
}
