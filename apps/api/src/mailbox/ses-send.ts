// Sending a store-held mailbox's mail through Amazon SES directly (docs/mailbox-store-plan.md, phase 2 step 3),
// instead of through Stalwart's relay. Uses the IAM user xstate-mail-send (MAIL_SEND_ACCESS_KEY_ID), allowed only to
// send; the identity-managing user (mailserver/ses.ts) can't. SES_MODE "fake" or "off" sends nothing and logs it.

import { AwsClient } from 'aws4fetch'
import { EmailError } from '../mailserver/errors'

export type SendEnv = Pick<Env, 'AWS_SES_REGION' | 'SES_MODE' | 'ENVIRONMENT'> & { MAIL_SEND_ACCESS_KEY_ID?: string; MAIL_SEND_SECRET_ACCESS_KEY?: string }

export type SesOutgoing = {
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  /** The message as it leaves: no Bcc header. */
  raw: Uint8Array
}

let client: { key: string; aws: AwsClient } | null = null

function aws(env: SendEnv): AwsClient {
  if (!env.MAIL_SEND_ACCESS_KEY_ID || !env.MAIL_SEND_SECRET_ACCESS_KEY) {
    throw new EmailError('sending_not_configured', 'Sending from this mailbox is not set up yet', 503)
  }
  if (client?.key !== env.MAIL_SEND_ACCESS_KEY_ID) {
    client = {
      key: env.MAIL_SEND_ACCESS_KEY_ID,
      aws: new AwsClient({ accessKeyId: env.MAIL_SEND_ACCESS_KEY_ID, secretAccessKey: env.MAIL_SEND_SECRET_ACCESS_KEY, service: 'ses', region: env.AWS_SES_REGION }),
    }
  }
  return client.aws
}

/** The Message-ID SES gives a message it sends (it replaces ours): the Sent copy uses it, so replies match. */
export const sesMessageId = (env: Pick<Env, 'AWS_SES_REGION'>, sesId: string) => `${sesId}@${env.AWS_SES_REGION}.amazonses.com`

/** Sends the message; returns SES's message id. */
export async function sendRaw(env: SendEnv, m: SesOutgoing): Promise<string> {
  const mode = (env.SES_MODE as string | undefined) ?? 'live'
  if (mode !== 'live') {
    const id = `fake-${crypto.randomUUID()}`
    console.log('ses-send (fake)', JSON.stringify({ id, from: m.from, to: m.to, cc: m.cc, bcc: m.bcc, bytes: m.raw.length }))
    return id
  }
  const res = await aws(env).fetch(`https://email.${env.AWS_SES_REGION}.amazonaws.com/v2/email/outbound-emails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: jsonBody(m),
  })
  const text = await res.text()
  if (!res.ok) {
    if (res.status === 429) throw new EmailError('send_limit_reached', 'Amazon SES is sending too fast right now; try again in a moment', 429)
    throw new EmailError('ses_error', `Amazon SES refused the message (HTTP ${res.status}): ${text.slice(0, 200)}`, 502)
  }
  const id = (JSON.parse(text) as { MessageId?: string }).MessageId
  if (!id) throw new EmailError('ses_error', 'Amazon SES returned no message id', 502)
  return id
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * The SendEmail request as bytes: the JSON around the raw message's base64, written straight into one buffer, so a
 * large message isn't copied through strings on its way out.
 */
function jsonBody(m: SesOutgoing): Uint8Array {
  const enc = new TextEncoder()
  const prefix = enc.encode(
    // No FromEmailAddress: with it SES rewrites the From header to the bare address, dropping the display name (seen
    // on the pilot); without it, SES sends from the message's own From header, as it was built.
    JSON.stringify({ Destination: { ToAddresses: m.to, CcAddresses: m.cc, BccAddresses: m.bcc }, Content: { Raw: { Data: '' } } }).replace(/""}}}$/, '"'),
  )
  const suffix = enc.encode('"}}}')
  const b64Length = Math.ceil(m.raw.length / 3) * 4
  const out = new Uint8Array(prefix.length + b64Length + suffix.length)
  out.set(prefix, 0)
  let o = prefix.length
  const bytes = m.raw
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out[o++] = B64.charCodeAt(a >> 2)
    out[o++] = B64.charCodeAt(((a & 3) << 4) | (b >> 4))
    out[o++] = i + 1 < bytes.length ? B64.charCodeAt(((b & 15) << 2) | (c >> 6)) : 61
    out[o++] = i + 2 < bytes.length ? B64.charCodeAt(c & 63) : 61
  }
  out.set(suffix, o)
  return out
}
