// Judges one email handed over by Stalwart's MTA hook (https://stalw.art/docs/mta/filter/mtahooks), at the DATA
// stage, before the message is accepted:
//   1. every attachment goes through the same file-type rules the API uses (api/src/security/attachments.ts),
//      where "blocked" means the whole message is refused, as Gmail does;
//   2. the whole message goes to ClamAV, which unpacks MIME and archives itself.
// A refused message gets a 5xx reply during SMTP, so the sender's server tells them. Nothing is stored.

import PostalMime from 'postal-mime'
import { inspect, type Safety } from '../../api/src/security/attachments.ts'
import { hasEicar, type Clamd } from './clamd.ts'

/** The parts of Stalwart's hook request this service reads. */
export type HookRequest = {
  context?: { stage?: string; client?: { ip?: string }; sasl?: { login?: string }; queue?: { id?: string } }
  envelope?: { from?: { address?: string }; to?: { address?: string }[] }
  message?: { headers?: [string, string][]; contents?: string; size?: number }
}

export type HookResponse =
  | { action: 'accept' }
  | { action: 'reject'; response: { status: number; enhanced_status: string; message: string } }

export type Verdict =
  | { ok: true }
  | { ok: false; reason: 'blocked_type'; file: string; detail: string }
  | { ok: false; reason: 'virus'; virus: string }

/**
 * The message as it was sent: Stalwart gives the header fields as [name, raw value] pairs (the value keeps its
 * leading space and line ending) and the body separately.
 */
export function rawMessage(message: NonNullable<HookRequest['message']>): Uint8Array {
  const head = (message.headers ?? []).map(([name, value]) => `${name}:${/\n$/.test(value) ? value : `${value}\r\n`}`).join('')
  return new TextEncoder().encode(`${head}\r\n${message.contents ?? ''}`)
}

export type Part = { name: string; bytes: Uint8Array }

/** Every attached or inline part, at any depth (attached messages are opened too). */
export async function attachments(raw: Uint8Array, depth = 0): Promise<Part[]> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' })
  const parts: Part[] = []
  for (const a of email.attachments) {
    const bytes = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content)
    // Parts without a name are judged by their bytes alone.
    parts.push({ name: a.filename || 'attachment', bytes })
    // A forwarded message as an attachment: its own attachments count.
    if (a.mimeType === 'message/rfc822' && depth < 3) parts.push(...(await attachments(bytes, depth + 1).catch(() => [])))
  }
  return parts
}

export async function judge(raw: Uint8Array, clam: Clamd, fake = false): Promise<Verdict> {
  const parts = await attachments(raw).catch(() => [] as Part[])
  for (const part of parts) {
    const safety: Safety = await inspect(part.bytes, part.name)
    if (safety.level === 'blocked') return { ok: false, reason: 'blocked_type', file: part.name, detail: safety.code ?? 'blocked_type' }
  }
  const scan = await clam.scan(raw)
  if (scan.infected) return { ok: false, reason: 'virus', virus: scan.virus }
  // The fake scanner doesn't decode MIME, so it also looks at each decoded attachment.
  if (fake && parts.some((p) => hasEicar(p.bytes))) return { ok: false, reason: 'virus', virus: 'Eicar-Test-Signature' }
  return { ok: true }
}

const reject = (message: string): HookResponse => ({ action: 'reject', response: { status: 550, enhanced_status: '5.7.1', message } })

/** The SMTP reply for a verdict. Short and plain: it ends up in the sender's bounce message. */
export function hookResponse(verdict: Verdict): HookResponse {
  if (verdict.ok) return { action: 'accept' }
  if (verdict.reason === 'virus') return reject(`Message refused: a virus was found (${clean(verdict.virus)}).`)
  return reject(`Message refused: the attachment "${clean(verdict.file)}" is a file type that can run programs. Send it another way.`)
}

/** SMTP replies are one line of ASCII. */
const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').replace(/"/g, "'").slice(0, 80)
