// POST /v1/collect: identify, track and page calls from the browser snippet (publishable key) or a customer's server
// (secret key). Checks the key and any user hash here, then hands the batch to the organization's AudienceStore.
//
// Browser:  { "key": "pk_live_…", "anonymousId": "vis_…", "events": [{ "type": "page", "url": "…" }, …] }
//           Sent as text/plain so it needs no CORS preflight. The website's domain comes from the Origin header.
//           identify() with a userId must carry userHash = hex HMAC-SHA256(secret key, userId), made on the
//           customer's server; without it the userId is ignored and only the visitor's own lead is updated.
// Server:   Authorization: Bearer sk_live_…, same body without "key". Each event names its "domain" (or a "url"),
//           and may use "userId" or "email" without a hash.
//           A server has no browser, so it may describe the visitor in "context" (Segment-style): ip, userAgent,
//           locale, campaign, referrer, page, sessionId. Nothing is geolocated from a context ip.
//
// Every event also gets a context (types.ts EventContext): for browsers the IP, location and network from
// Cloudflare (request.cf), the browser, system and device from the User-Agent, and the snippet's visit, campaign,
// screen and locale. Requests from bots are dropped. Whether the IP itself is kept is up to the organization
// (AudienceStore settings); location is always kept.

import { audiencePaused } from '../limits'
import type { Context } from 'hono'
import { z } from 'zod'
import { ApiError } from '../errors'
import type { AppEnv } from '../http/types'
import { CLICK_IDS, channelOf, hostOf, sameSite } from './channel'
import { isBot, parseUserAgent } from './device'
import * as keys from './keys'
import { organizationSites, siteOf } from './site'
import type { CollectBatch, CollectItem, EventContext } from './types'

const MAX_BODY = 64 * 1024
const MAX_JSON = 4 * 1024
/** Names xstate records itself: page views, identify calls and email activity. */
const RESERVED = /^\$(pageview|identify|email_)/

const id = z.string().trim().min(1).max(128)
const json = z.record(z.string().max(64), z.unknown()).default({})

const text = (max: number) => z.string().trim().max(max).optional()

// Whatever is malformed in a context is dropped (.catch), never the event.
const context = z
  .object({
    session: z.object({ id: z.string().trim().min(1).max(64), start: z.boolean().optional() }).optional(),
    sessionId: text(64),
    campaign: z.object({ source: text(200), medium: text(200), name: text(200), term: text(200), content: text(200) }).optional(),
    clickId: z.object({ kind: z.enum(CLICK_IDS), value: text(500) }).optional(),
    referrer: text(2000),
    page: z.object({ path: text(1000), url: text(2000), referrer: text(2000), title: text(300) }).optional(),
    screen: text(20),
    viewport: text(20),
    locale: text(35),
    timezone: text(64),
    library: z.object({ name: text(40), version: text(20) }).optional(),
    ip: text(45),
    userAgent: text(500),
  })
  .optional()
  .catch(undefined)
type RawContext = z.output<typeof context>

const event = z.object({
  type: z.enum(['identify', 'track', 'page', 'page_leave']),
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
  context,
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

  // What the request itself says about a browser visitor. A server's request says nothing about its visitors.
  const userAgent = c.req.header('User-Agent') ?? ''
  if (!trusted && isBot(userAgent)) return c.json({ accepted: 0 }, 202)
  const visitor = trusted ? null : fromRequest(c.req.raw, userAgent)

  if (!trusted) {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
    const { success } = await c.env.COLLECT_RATE.limit({ key: `${auth.organizationId}:${ip}` })
    if (!success) throw new ApiError('rate_limited', 'Too many events from this visitor', 429)
  }

  const sites = await organizationSites(c.env, auth.organizationId)
  const originHost = hostOf(c.req.header('Origin'))
  const now = Date.now()
  const items: CollectItem[] = []
  for (const e of input.events) {
    const domain = trusted ? (e.domain ?? hostOf(e.url)) : (originHost ?? hostOf(e.url))
    if (!domain) {
      if (trusted) throw new ApiError('invalid_input', 'Each event needs a "domain" (or a "url") when sent with the secret key')
      continue
    }
    if (e.type === 'track' && e.event && RESERVED.test(e.event)) throw new ApiError('invalid_input', `"${e.event}" is recorded by xstate itself`)
    if (e.type === 'track' && !e.event) throw new ApiError('invalid_input', 'track events need an "event" name')
    let userId: string | null = null
    if (e.userId) {
      if (trusted) userId = e.userId
      else if (e.userHash && (await keys.verifyUserHash(auth.secret, e.userId, e.userHash))) userId = e.userId
    }
    const anonymousId = e.anonymousId ?? input.anonymousId ?? null
    if (!anonymousId && !userId && !(trusted && e.email)) continue
    const host = normalizeHost(domain)
    items.push({
      type: e.type,
      domain: host,
      site: siteOf(host, sites),
      anonymousId,
      userId,
      email: trusted ? (e.email ?? null) : null,
      traits: capJson(e.traits),
      event: e.event ?? null,
      properties: capJson(e.properties),
      url: e.url ?? null,
      context: contextOf(e.type, e.url ?? null, host, e.context, visitor, trusted),
      at: timestampOf(e.timestamp, now),
    })
  }
  // Free over 110% of its audience this month: no new identified visitors (limits/). Page views still count.
  if (items.some((i) => i.type === 'identify') && (await pausedCached(c.env, auth.organizationId))) {
    items.splice(0, items.length, ...items.filter((i) => i.type !== 'identify'))
  }
  if (!items.length) return c.json({ accepted: 0 }, 202)

  const batch: CollectBatch = { trusted, source: trusted ? 'API' : 'Website', items, sites }
  const store = c.env.AUDIENCE.get(c.env.AUDIENCE.idFromName(auth.organizationId))
  if (trusted) return c.json(await store.collect(batch), 200)
  // Browsers don't wait for the write.
  c.executionCtx.waitUntil(store.collect(batch).catch((err: unknown) => console.error('audience collect failed', err)))
  return c.json({ accepted: items.length }, 202)
}

/** The pause is set hourly, so a few minutes' cache per isolate keeps collect from reading D1 on every call. */
const pauseCache = new Map<string, { paused: boolean; at: number }>()
async function pausedCached(env: Env, organizationId: string): Promise<boolean> {
  const hit = pauseCache.get(organizationId)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.paused
  const paused = await audiencePaused(env, organizationId).catch(() => false)
  if (pauseCache.size > 1000) pauseCache.clear()
  pauseCache.set(organizationId, { paused, at: Date.now() })
  return paused
}

const normalizeHost = (host: string) => host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')

/** The browser visitor's IP, location, network and device. */
function fromRequest(req: Request, userAgent: string): EventContext {
  const cf = req.cf as IncomingRequestCfProperties | undefined
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined)
  // Roughly the city, not the street: one decimal is about 10 km.
  const coarse = (v: unknown) => {
    const n = num(v)
    return n === undefined ? undefined : Math.round(n * 10) / 10
  }
  const device = parseUserAgent(userAgent)
  return clean({
    ip: req.headers.get('CF-Connecting-IP') ?? undefined,
    country: cf?.country ?? undefined,
    region: cf?.region || undefined,
    regionCode: cf?.regionCode || undefined,
    city: cf?.city || undefined,
    postalCode: cf?.postalCode || undefined,
    timezone: cf?.timezone || undefined,
    latitude: coarse(cf?.latitude),
    longitude: coarse(cf?.longitude),
    continent: cf?.continent || undefined,
    isEu: cf?.isEUCountry === '1' ? true : undefined,
    asn: num(cf?.asn),
    asOrganization: cf?.asOrganization || undefined,
    ...deviceContext(device),
  })
}

function deviceContext(d: ReturnType<typeof parseUserAgent>): EventContext {
  return {
    browser: d.browser ?? undefined,
    browserVersion: d.browserVersion ?? undefined,
    os: d.os ?? undefined,
    osVersion: d.osVersion ?? undefined,
    deviceType: d.deviceType ?? undefined,
  }
}

/** The event's full context: the request's (browsers), what the snippet or server sent, and the visit's channel. */
function contextOf(
  type: CollectItem['type'],
  url: string | null,
  domain: string,
  raw: RawContext,
  visitor: EventContext | null,
  trusted: boolean,
): EventContext {
  const ctx: EventContext = { ...visitor }
  if (raw) {
    const sessionId = raw.session?.id ?? (trusted ? raw.sessionId : undefined)
    if (sessionId) ctx.sessionId = sessionId
    if (raw.session?.start) ctx.sessionStart = true
    if (raw.screen) ctx.screen = raw.screen
    if (raw.viewport) ctx.viewport = raw.viewport
    if (raw.locale) ctx.locale = raw.locale
    if (raw.library?.name) ctx.library = [raw.library.name, raw.library.version].filter(Boolean).join(' ')
    if (raw.timezone && !ctx.timezone) ctx.timezone = raw.timezone
    if (trusted) {
      if (raw.ip) ctx.ip = raw.ip
      if (raw.userAgent) Object.assign(ctx, deviceContext(parseUserAgent(raw.userAgent)))
    }
  }

  const pageUrl = raw?.page?.url ?? url
  const path = raw?.page?.path ?? pathOf(pageUrl)
  if (path) ctx.path = path

  // Attribution: the snippet sends it on a visit's first page; a server whenever it knows it.
  const campaign = raw?.campaign && Object.values(raw.campaign).some(Boolean) ? clean(raw.campaign) : undefined
  const clickId = raw?.clickId?.kind
  const referrer = raw?.referrer ?? raw?.page?.referrer
  const refHost = hostOf(referrer)
  const external = refHost && !sameSite(refHost, domain) ? refHost : undefined
  if (campaign) ctx.campaign = campaign
  if (clickId) ctx.clickId = clickId
  if (external && referrer) {
    ctx.referrer = referrer
    ctx.referringDomain = external
  }
  if (ctx.sessionStart || campaign || clickId || external) {
    ctx.channel = channelOf({ campaign, clickId, referringDomain: external })
  }
  return ctx
}

function pathOf(url: string | null): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).pathname.slice(0, 1000)
  } catch {
    return undefined
  }
}

/** Drops undefined and empty values, so contexts stay small. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as T
}

/** Client clocks drift: accept times up to a week back and five minutes ahead, else use now. */
function timestampOf(value: string | undefined, now: number): string {
  const t = value ? Date.parse(value) : NaN
  return Number.isFinite(t) && t > now - 7 * 86_400_000 && t < now + 300_000 ? new Date(t).toISOString() : new Date(now).toISOString()
}

/** Properties and traits are kept small: anything past 4 KB of JSON is dropped. */
function capJson(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.stringify(value).length <= MAX_JSON ? value : {}
}
