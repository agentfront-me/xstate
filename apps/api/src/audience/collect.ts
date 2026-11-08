// POST /v1/collect: identify, track and page calls from the browser snippet (publishable key) or a customer's server
// (secret key). Checks the key and any user hash here, then hands the batch to the organization's AudienceStore.
//
// Browser:  { "key": "pk_live_…", "anonymousId": "vis_…", "events": [{ "type": "page", "url": "…" }, …] }
//           Sent as text/plain so it needs no CORS preflight. The website's domain comes from the Origin header.
//           identify() with a userId must carry userHash = hex HMAC-SHA256(secret key, userId), made on the
//           customer's server; without it the userId is ignored and only the visitor's own lead is updated.
// Server:   Authorization: Bearer sk_live_…, same body without "key". Each event names its "domain" (or a "url"),
//           and may use "userId" or "email" without a hash.

import type { Context } from 'hono'
import { z } from 'zod'
import { ApiError } from '../errors'
import type { AppEnv } from '../http/types'
import * as keys from './keys'
import type { CollectBatch, CollectItem } from './types'

const MAX_BODY = 64 * 1024
const MAX_JSON = 4 * 1024

const id = z.string().trim().min(1).max(128)
const json = z.record(z.string().max(64), z.unknown()).default({})

const event = z.object({
  type: z.enum(['identify', 'track', 'page']),
  event: z.string().trim().min(1).max(100).optional(),
  anonymousId: id.optional(),
  userId: id.optional(),
  userHash: z.string().max(128).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  traits: json,
  properties: json,
  url: z.string().max(2000).optional(),
  domain: z.string().trim().toLowerCase().max(253).optional(),
  timestamp: z.string().max(40).optional(),
})

const body = z.object({
  key: z.string().max(100).optional(),
  anonymousId: id.optional(),
  events: z.array(event).min(1).max(50),
})

export async function handleCollect(c: Context<AppEnv>): Promise<Response> {
  const raw = await c.req.text()
  if (raw.length > MAX_BODY) throw new ApiError('too_large', 'Send at most 64 KB per request')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiError('invalid_json', 'The request body must be JSON')
  }
  // A single event may be sent on its own, without the "events" array.
  if (parsed && typeof parsed === 'object' && !('events' in parsed) && 'type' in parsed) {
    const { key, anonymousId, ...rest } = parsed as Record<string, unknown>
    parsed = { key, anonymousId, events: [rest] }
  }
  const input = body.parse(parsed)

  const bearer = c.req.header('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  const auth = bearer ? await keys.bySecret(c.env, bearer) : input.key ? await keys.byPublishable(c.env, input.key) : null
  if (!auth) throw new ApiError('invalid_key', bearer ? 'Unknown secret key' : 'Send a valid publishable key as "key"', 401)
  const trusted = !!bearer

  if (!trusted) {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
    const { success } = await c.env.COLLECT_RATE.limit({ key: `${auth.organizationId}:${ip}` })
    if (!success) throw new ApiError('rate_limited', 'Too many events from this visitor', 429)
  }

  const originHost = hostOf(c.req.header('Origin'))
  const now = Date.now()
  const items: CollectItem[] = []
  for (const e of input.events) {
    const domain = trusted ? (e.domain ?? hostOf(e.url)) : (originHost ?? hostOf(e.url))
    if (!domain) {
      if (trusted) throw new ApiError('invalid_input', 'Each event needs a "domain" (or a "url") when sent with the secret key')
      continue
    }
    if (e.type === 'track' && !e.event) throw new ApiError('invalid_input', 'track events need an "event" name')
    let userId: string | null = null
    if (e.userId) {
      if (trusted) userId = e.userId
      else if (e.userHash && (await keys.verifyUserHash(auth.secret, e.userId, e.userHash))) userId = e.userId
    }
    const anonymousId = e.anonymousId ?? input.anonymousId ?? null
    if (!anonymousId && !userId && !(trusted && e.email)) continue
    items.push({
      type: e.type,
      domain: normalizeHost(domain),
      anonymousId,
      userId,
      email: trusted ? (e.email ?? null) : null,
      traits: capJson(e.traits),
      event: e.event ?? null,
      properties: capJson(e.properties),
      url: e.url ?? null,
      at: timestampOf(e.timestamp, now),
    })
  }
  if (!items.length) return c.json({ accepted: 0 }, 202)

  const batch: CollectBatch = { trusted, source: trusted ? 'API' : 'Website', items }
  const store = c.env.AUDIENCE.get(c.env.AUDIENCE.idFromName(auth.organizationId))
  if (trusted) return c.json(await store.collect(batch), 200)
  // Browsers don't wait for the write.
  c.executionCtx.waitUntil(store.collect(batch).catch((err: unknown) => console.error('audience collect failed', err)))
  return c.json({ accepted: items.length }, 202)
}

function hostOf(url: string | undefined | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

const normalizeHost = (host: string) => host.replace(/^www\./, '').replace(/\.$/, '')

/** Client clocks drift: accept times up to a week back and five minutes ahead, else use now. */
function timestampOf(value: string | undefined, now: number): string {
  const t = value ? Date.parse(value) : NaN
  return Number.isFinite(t) && t > now - 7 * 86_400_000 && t < now + 300_000 ? new Date(t).toISOString() : new Date(now).toISOString()
}

/** Properties and traits are kept small: anything past 4 KB of JSON is dropped. */
function capJson(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.stringify(value).length <= MAX_JSON ? value : {}
}
