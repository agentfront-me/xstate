// A person's metrics (Person.metrics): what xstate works out from their events, kept on the person so lists,
// segments and the dashboard read them without scanning events. Updated in the same transaction as each event
// (store.ts collectOne). The customer never sets these; their own data stays in `attributes`.
//
//   First touch   initial_channel, initial_utm_*, initial_click_id, initial_referrer, initial_referring_domain,
//                 initial_landing_page
//   Last touch    last_channel, last_utm_*, last_click_id, last_referring_domain
//   Location      country, region, city, timezone (latest), first_country
//   Device        last_browser, last_os, last_device_type
//   Activity      sessions, pageviews, events, active_days, engaged_seconds, last_event, last_page
//   Revenue       revenue_total, orders, currency, first_order_at (from a numeric "revenue" property on any event)
//   Email         emails_received, emails_replied, emails_sent, last_email_at, email_bounced, email_complained
//   Lifecycle     identified_at, days_to_identify (set when a lead becomes a user)

import type { Attributes, CollectItem } from './types'

export type Metrics = Attributes

const DAY = 86_400_000
const UTM = ['source', 'medium', 'name', 'term', 'content'] as const
const utmKey = (k: (typeof UTM)[number]) => (k === 'name' ? 'campaign' : k)

const inc = (m: Metrics, key: string, by = 1) => {
  m[key] = (typeof m[key] === 'number' ? m[key] : 0) + by
}

/** The metrics after one collected event. `newSession`: this event opened a visit that wasn't known before. */
export function applyEvent(metrics: Metrics, item: CollectItem, opts: { newSession: boolean }): Metrics {
  const m: Metrics = { ...metrics }
  const ctx = item.context

  if (ctx.channel) {
    // First touch is the first visit we hear about, whatever it was (Direct included); last touch is the latest.
    if (m.initial_channel === undefined) {
      m.initial_channel = ctx.channel
      for (const k of UTM) if (ctx.campaign?.[k]) m[`initial_utm_${utmKey(k)}`] = ctx.campaign[k]!
      if (ctx.clickId) m.initial_click_id = ctx.clickId
      if (ctx.referrer) m.initial_referrer = ctx.referrer.slice(0, 500)
      if (ctx.referringDomain) m.initial_referring_domain = ctx.referringDomain
      if (ctx.path) m.initial_landing_page = ctx.path
    }
    m.last_channel = ctx.channel
    for (const k of UTM) {
      if (ctx.campaign?.[k]) m[`last_utm_${utmKey(k)}`] = ctx.campaign[k]!
      else delete m[`last_utm_${utmKey(k)}`]
    }
    if (ctx.clickId) m.last_click_id = ctx.clickId
    else delete m.last_click_id
    if (ctx.referringDomain) m.last_referring_domain = ctx.referringDomain
    else delete m.last_referring_domain
  }

  if (ctx.country) {
    if (m.first_country === undefined) m.first_country = ctx.country
    m.country = ctx.country
    // Region and city belong to the country they came with: clear them when the new location doesn't have them.
    for (const k of ['region', 'city'] as const) {
      if (ctx[k]) m[k] = ctx[k]
      else delete m[k]
    }
  }
  if (ctx.timezone) m.timezone = ctx.timezone
  if (ctx.browser) m.last_browser = ctx.browser
  if (ctx.os) m.last_os = ctx.os
  if (ctx.deviceType) m.last_device_type = ctx.deviceType

  if (opts.newSession) inc(m, 'sessions')
  if (item.type === 'page' || item.type === 'track') {
    inc(m, 'events')
    const day = item.at.slice(0, 10)
    if (typeof m.last_active_day !== 'string' || day > m.last_active_day) {
      inc(m, 'active_days')
      m.last_active_day = day
    }
  }
  if (item.type === 'page') {
    inc(m, 'pageviews')
    if (ctx.path) m.last_page = ctx.path
  }
  if (item.type === 'track' && item.event) {
    m.last_event = item.event
    const revenue = Number(item.properties.revenue)
    if (item.properties.revenue !== undefined && item.properties.revenue !== '' && Number.isFinite(revenue)) {
      m.revenue_total = Math.round(((typeof m.revenue_total === 'number' ? m.revenue_total : 0) + revenue) * 100) / 100
      inc(m, 'orders')
      if (typeof item.properties.currency === 'string' && item.properties.currency) m.currency = item.properties.currency.slice(0, 3).toUpperCase()
      if (m.first_order_at === undefined) m.first_order_at = item.at
    }
  }
  return m
}

export type EmailKind = 'received' | 'replied' | 'sent' | 'bounced' | 'complained'

/** Mail between the organization's mailboxes and the person (audience/email.ts). */
export function applyEmail(metrics: Metrics, kind: EmailKind, at: string): Metrics {
  const m: Metrics = { ...metrics }
  if (kind === 'bounced') m.email_bounced = true
  else if (kind === 'complained') m.email_complained = true
  else {
    inc(m, kind === 'received' ? 'emails_received' : kind === 'replied' ? 'emails_replied' : 'emails_sent')
    if (typeof m.last_email_at !== 'string' || at > m.last_email_at) m.last_email_at = at
  }
  return m
}

/** Time on page, in whole seconds, added from a page_leave (only the part not counted before). */
export function addEngagement(metrics: Metrics, addedMs: number): Metrics {
  if (addedMs <= 0) return metrics
  const m = { ...metrics }
  const total = (typeof m.engaged_ms === 'number' ? m.engaged_ms : 0) + addedMs
  m.engaged_ms = total
  m.engaged_seconds = Math.round(total / 1000)
  return m
}

/** A lead becoming a user. */
export function identified(metrics: Metrics, at: string, firstSeenAt: string): Metrics {
  if (metrics.identified_at !== undefined) return metrics
  return { ...metrics, identified_at: at, days_to_identify: Math.max(0, Math.floor((Date.parse(at) - Date.parse(firstSeenAt)) / DAY)) }
}

const COUNTERS = ['sessions', 'pageviews', 'events', 'active_days', 'engaged_ms', 'engaged_seconds', 'orders', 'revenue_total', 'emails_received', 'emails_replied', 'emails_sent']

/**
 * A lead's metrics folded into the user it turned out to be. Counters add up (active_days may count a day twice:
 * close enough), first touch comes from whoever was seen first, everything else stays the user's unless missing.
 */
export function mergeMetrics(from: Metrics, into: Metrics, fromIsOlder: boolean): Metrics {
  const m: Metrics = { ...from, ...into }
  for (const k of COUNTERS) {
    const a = typeof from[k] === 'number' ? from[k] : 0
    const b = typeof into[k] === 'number' ? into[k] : 0
    if (a || b) m[k] = k === 'revenue_total' ? Math.round((a + b) * 100) / 100 : a + b
  }
  if (fromIsOlder) {
    for (const k of Object.keys(m)) if (k.startsWith('initial_')) delete m[k]
    for (const [k, v] of Object.entries(from)) if (k.startsWith('initial_') || k === 'first_country' || k === 'first_order_at') m[k] = v
  }
  if (typeof from.last_active_day === 'string' && typeof into.last_active_day === 'string') {
    m.last_active_day = from.last_active_day > into.last_active_day ? from.last_active_day : into.last_active_day
  }
  return m
}
