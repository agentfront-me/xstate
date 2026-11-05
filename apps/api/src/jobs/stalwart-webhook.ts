// POST /webhooks/stalwart: Stalwart's telemetry webhook, filtered (on Stalwart) to message-ingest events.
//
// Request: {"events":[{"id","createdAt","type","data":{"accountId":10,...}}]}, signed with an X-Signature header
// (base64 HMAC-SHA256 of the raw body, key STALWART_WEBHOOK_SECRET). See https://stalw.art/docs/telemetry/webhooks/.
// We only learn which accounts got mail; each matching mailbox is queued for a sync, which reads Stalwart's change
// log. Accounts that aren't xstate mailboxes are ignored. Replies 2xx quickly, or Stalwart retries and backs up.

import type { Context } from 'hono'
import * as mailboxesDb from '../db/mailboxes'
import { jmapId } from '../mailserver/stalwart/ids'
import { enqueue } from './mail-sync'

/** Events that mean a message was added to an account. */
const INGEST_EVENTS = new Set([
  'message-ingest.ham',
  'message-ingest.spam',
  'message-ingest.imap-append',
  'message-ingest.jmap-append',
])

type WebhookEvent = { id?: string; type?: string; data?: { accountId?: number | string } }

export async function handleStalwartWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await c.req.text()
  if (!c.env.STALWART_WEBHOOK_SECRET) return c.json({ error: { code: 'not_configured', message: 'Webhook secret not set' } }, 503)
  if (!(await validSignature(c.env.STALWART_WEBHOOK_SECRET, body, c.req.header('X-Signature')))) {
    return c.json({ error: { code: 'invalid_signature', message: 'Bad or missing X-Signature' } }, 401)
  }

  let events: WebhookEvent[]
  try {
    events = (JSON.parse(body) as { events?: WebhookEvent[] }).events ?? []
  } catch {
    return c.json({ error: { code: 'invalid_json', message: 'Body is not JSON' } }, 400)
  }

  const accounts = new Set<string>()
  for (const event of events) {
    if (!event.type || !INGEST_EVENTS.has(event.type)) continue
    const raw = event.data?.accountId
    if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) continue
    accounts.add(jmapId(String(raw)))
  }
  const mailboxIds = await mailboxesDb.idsByStalwartIds(c.env.DB, [...accounts])
  await enqueue(c.env, mailboxIds.map((mailboxId) => ({ mailboxId, reason: 'webhook' })))
  return c.json({ received: events.length, queued: mailboxIds.length }, 202)
}

async function validSignature(secret: string, body: string, header: string | undefined): Promise<boolean> {
  if (!header) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  let given: Uint8Array
  try {
    given = Uint8Array.from(atob(header.trim()), (ch) => ch.charCodeAt(0))
  } catch {
    return false
  }
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected)
}
