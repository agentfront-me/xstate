// POST /v1/emails: what a request may contain, and the parts of the send log that need no database. The rest is
// in ./service.ts. See docs/transactional-api-plan.md.

import { z } from 'zod'

export const MAX_RECIPIENTS = 50
export const MAX_ATTACHMENTS = 20
/** Attachments in total, after decoding. The same limit as mail written in the app. */
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024
/** How long an Idempotency-Key is remembered. */
export const IDEMPOTENCY_HOURS = 24
/** How long a message stays in the send log. */
export const LOG_DAYS = 30

const emailAddress = z.email().max(254)
/** "you@example.com" or { email, name }. */
const address = z
  .union([emailAddress, z.strictObject({ email: emailAddress, name: z.string().trim().max(200).nullish() })])
  .transform((a) => (typeof a === 'string' ? { email: a.toLowerCase(), name: null } : { email: a.email.toLowerCase(), name: a.name || null }))
const addresses = z.array(address).max(MAX_RECIPIENTS)

/** Headers a caller may add: their own X- headers, and the two that give mail apps an unsubscribe button. */
const HEADER_NAME = /^(x-[a-z0-9-]{1,60}|list-unsubscribe|list-unsubscribe-post)$/i
/** No control characters: a line break here would let a caller add any header they like. */
const HEADER_VALUE = /^[\x20-\x7e]{1,900}$/
const TAG_KEY = /^[A-Za-z0-9_-]{1,40}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const attachment = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((n) => !/[\\/\x00-\x1f]/.test(n), 'A file name can’t contain slashes or control characters'),
  type: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/i, 'Not a MIME type, e.g. application/pdf'),
  /** The file, base64. Line breaks are allowed and ignored. */
  content: z.string().min(1),
  /** For an image the HTML shows as <img src="cid:…">. */
  contentId: z
    .string()
    .regex(/^[A-Za-z0-9._@-]{1,100}$/)
    .optional(),
})

/** An object whose names must match `pattern`, with a message that says so (z.record's own is "Invalid key"). */
function named(pattern: RegExp, max: number, what: string, message: string, value: z.ZodString) {
  return z
    .record(z.string(), value)
    .superRefine((object, ctx) => {
      const names = Object.keys(object)
      for (const name of names) if (!pattern.test(name)) ctx.addIssue({ code: 'custom', path: [name], message: `${message} ("${name}")` })
      if (names.length > max) ctx.addIssue({ code: 'custom', message: `At most ${max} ${what}` })
    })
    .optional()
}

export const sendInput = z
  .strictObject({
    from: address,
    to: addresses.min(1, 'Add at least one recipient in "to"'),
    cc: addresses.optional(),
    bcc: addresses.optional(),
    replyTo: z.array(address).max(5).optional(),
    subject: z.string().max(998),
    text: z.string().max(1_000_000).optional(),
    html: z.string().max(2_000_000).optional(),
    attachments: z.array(attachment).max(MAX_ATTACHMENTS).optional(),
    headers: named(HEADER_NAME, 20, 'headers', 'Only X-… headers, List-Unsubscribe and List-Unsubscribe-Post can be set', z.string().regex(HEADER_VALUE, 'A header value is 1 to 900 printable ASCII characters on one line')),
    tags: named(TAG_KEY, 10, 'tags', 'A tag name is 1 to 40 letters, digits, _ or -', z.string().max(200)),
    saveToSent: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (!input.text && !input.html) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Send text, html or both' })
    const all = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]
    if (all.length > MAX_RECIPIENTS) ctx.addIssue({ code: 'custom', path: ['to'], message: `A message can have at most ${MAX_RECIPIENTS} recipients in to, cc and bcc together` })
    const seen = new Set<string>()
    for (const r of all) {
      if (seen.has(r.email)) ctx.addIssue({ code: 'custom', path: ['to'], message: `${r.email} is listed more than once` })
      seen.add(r.email)
    }
    const ids = (input.attachments ?? []).flatMap((a) => a.contentId ?? [])
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['attachments'], message: 'Each contentId can be used once' })
  })

export type SendInput = z.output<typeof sendInput>

/** The bytes of a base64 attachment, or null if it isn't base64. */
export function decodeBase64(content: string): Uint8Array | null {
  const clean = content.replace(/\s+/g, '')
  if (!clean || clean.length % 4 === 1 || !BASE64.test(clean)) return null
  let binary: string
  try {
    binary = atob(clean)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** About how many bytes a base64 string decodes to, to refuse an oversized request before decoding it. */
export const base64Bytes = (content: string) => Math.floor((content.length * 3) / 4)

/** A fingerprint of the request, so the same Idempotency-Key with a different body is refused instead of ignored. */
export async function requestHash(input: SendInput): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type RecipientStatus = 'queued' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'suppressed'
export type EmailStatus = Exclude<RecipientStatus, 'suppressed'> | 'partial'

/**
 * One status for the whole message. While nothing has gone wrong it is how far the slowest recipient has got:
 * `queued`, then `sent`, then `delivered` once every recipient has it. `bounced` or `complained` when that is true
 * of every recipient, and `partial` when it is true of some. Recipients skipped as suppressed don't count.
 */
export function overallStatus(recipients: readonly RecipientStatus[]): EmailStatus {
  const sent = recipients.filter((s) => s !== 'suppressed')
  const failed = sent.filter((s) => s === 'bounced' || s === 'complained')
  if (failed.length) return failed.length < sent.length || new Set(failed).size > 1 ? 'partial' : failed[0]!
  if (sent.includes('queued')) return 'queued'
  return sent.includes('sent') || !sent.length ? 'sent' : 'delivered'
}

/**
 * Whether a delivery event may replace a recipient's status. Events can arrive out of order and twice: a bounce or
 * complaint is never overwritten by a late "delivered", and a complaint (which follows a delivery) wins over it.
 */
export function nextStatus(current: RecipientStatus, event: 'delivered' | 'bounced' | 'complained'): RecipientStatus {
  if (current === 'suppressed' || current === 'complained') return current
  if (current === 'bounced') return event === 'complained' ? 'complained' : 'bounced'
  return event
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
export function newEmailId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return 'em_' + Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')
}

/** The seconds after which the cap named in a send_limit_reached message has certainly made room again. */
export const retryAfterSeconds = (limitMessage: string) => (/\ban hour\b/.test(limitMessage) ? 3600 : 86_400)
