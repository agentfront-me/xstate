// The Analytics Overview (docs/analytics-plan.md, phase 6): traffic totals, a chart and "top" lists, worked out
// from visits (the sessions table) so a period can be compared with the one before it. Visits are kept 180 days
// (events only 90), which is why the Overview reads them and not events, except for the page and event lists.
// Pure helpers and SQL here; AudienceStore runs them (store.ts overview / breakdown).

import { z } from 'zod'

export const SESSION_RETENTION_DAYS = 180

export const OVERVIEW_RANGES = ['today', '7', '30', '90'] as const
export type OverviewRange = (typeof OVERVIEW_RANGES)[number]

/** What a list can be broken down by, and what a filter chip can be on. */
export const DIMENSIONS = [
  'channel',
  'referrer',
  'campaign',
  'page',
  'landing',
  'exit',
  'country',
  'region',
  'city',
  'device',
  'browser',
  'os',
  'event',
] as const
export type Dimension = (typeof DIMENSIONS)[number]

export const overviewFilter = z.object({ dim: z.enum(DIMENSIONS), value: z.string().max(500) })
export type OverviewFilter = z.output<typeof overviewFilter>

type Binding = string | number | null

/** The key a visit has for a dimension (on sessions `s`). Composite keys keep "Paris, FR" apart from "Paris, US". */
const SESSION_KEY: Partial<Record<Dimension, string>> = {
  channel: "coalesce(s.channel, 'Direct')",
  referrer: 's.referring_domain',
  campaign: "coalesce(s.utm_source, '') || '|' || coalesce(s.utm_medium, '') || '|' || coalesce(s.utm_campaign, '')",
  landing: 's.landing_path',
  exit: 's.exit_path',
  country: 's.country',
  region: "s.region || '|' || coalesce(s.country, '')",
  city: "s.city || '|' || coalesce(s.country, '')",
  device: 's.device_type',
  browser: 's.browser',
  os: 's.os',
}

/** Rows a breakdown leaves out: visits with no value (no referrer is Direct, not a referrer). */
const SESSION_PRESENT: Partial<Record<Dimension, string>> = {
  referrer: 's.referring_domain IS NOT NULL',
  campaign: 'coalesce(s.utm_source, s.utm_medium, s.utm_campaign) IS NOT NULL',
  landing: 's.landing_path IS NOT NULL',
  exit: 's.exit_path IS NOT NULL',
  country: 's.country IS NOT NULL',
  region: 's.region IS NOT NULL',
  city: 's.city IS NOT NULL',
  device: 's.device_type IS NOT NULL',
  browser: 's.browser IS NOT NULL',
  os: 's.os IS NOT NULL',
}

const domainMatch = (col: string) => `(${col} = ? OR substr(${col}, -length(?) - 1) = '.' || ?)`

/** WHERE conditions on sessions `s` for a period, a site and the filter chips. */
export function sessionWhere(from: string, to: string, domain: string | undefined, filters: OverviewFilter[]): { sql: string; args: Binding[] } {
  const parts = ['s.started_at >= ?', 's.started_at < ?']
  const args: Binding[] = [from, to]
  if (domain) {
    parts.push(domainMatch('s.domain'))
    args.push(domain, domain, domain)
  }
  for (const f of filters) {
    if (f.dim === 'page') {
      parts.push("EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.name = '$pageview' AND e.path = ?)")
      args.push(f.value)
    } else if (f.dim === 'event') {
      parts.push('EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.name = ?)')
      args.push(f.value)
    } else {
      parts.push(`${SESSION_KEY[f.dim]} = ?`)
      args.push(f.value)
    }
  }
  return { sql: parts.join(' AND '), args }
}

/** Seconds a visit lasted: first to last event, or the time on its pages when that's longer (one-page visits). */
export const DURATION = 'max((julianday(s.ended_at) - julianday(s.started_at)) * 86400.0, s.engaged_ms / 1000.0)'
/** A bounce: one page view (or none) and under 10 seconds. */
export const BOUNCE = `CASE WHEN s.pageviews <= 1 AND ${DURATION} < 10 THEN 1 ELSE 0 END`

/** Totals for a period (on sessions `s` with the given WHERE). */
export function totalsQuery(where: { sql: string; args: Binding[] }) {
  return {
    sql: `SELECT count(DISTINCT s.person_id) AS visitors, count(*) AS visits, coalesce(sum(s.pageviews), 0) AS pageviews,
            coalesce(sum(${BOUNCE}), 0) AS bounces, coalesce(sum(${DURATION}), 0) AS seconds,
            coalesce(sum(s.revenue), 0) AS revenue, coalesce(sum(s.orders), 0) AS orders
          FROM sessions s WHERE ${where.sql}`,
    args: where.args,
  }
}

/** The same per bucket (local day or hour). `shift` moves UTC times to the viewer's time zone (SQLite modifier). */
export function seriesQuery(where: { sql: string; args: Binding[] }, bucket: 'day' | 'hour', shift: string) {
  const fmt = bucket === 'day' ? '%Y-%m-%d' : '%Y-%m-%dT%H'
  return {
    sql: `SELECT strftime('${fmt}', s.started_at, ?) AS b, count(DISTINCT s.person_id) AS visitors, count(*) AS visits,
            coalesce(sum(s.pageviews), 0) AS pageviews, coalesce(sum(${BOUNCE}), 0) AS bounces, coalesce(sum(${DURATION}), 0) AS seconds,
            coalesce(sum(s.revenue), 0) AS revenue, coalesce(sum(s.orders), 0) AS orders
          FROM sessions s WHERE ${where.sql} GROUP BY b ORDER BY b`,
    args: [shift, ...where.args],
  }
}

/** Top values of a dimension: visitors, visits (and revenue for conversions). Page and event lists read events. */
export function breakdownQuery(dim: Dimension, where: { sql: string; args: Binding[] }, limit: number, from: string, to: string) {
  if (dim === 'page' || dim === 'event') {
    const cond = dim === 'page' ? "e.name = '$pageview' AND e.path IS NOT NULL" : "e.type = 'track' AND e.name NOT LIKE '$%'"
    const key = dim === 'page' ? 'e.path' : 'e.name'
    return {
      sql: `SELECT ${key} AS key, count(DISTINCT e.person_id) AS visitors, count(DISTINCT e.session_id) AS visits, count(*) AS count
            FROM events e JOIN sessions s ON s.id = e.session_id
            WHERE ${cond} AND e.occurred_at >= ? AND e.occurred_at < ? AND ${where.sql}
            GROUP BY key ORDER BY ${dim === 'event' ? 'count' : 'visitors'} DESC, key LIMIT ?`,
      args: [from, to, ...where.args, limit],
    }
  }
  const key = SESSION_KEY[dim]!
  const present = SESSION_PRESENT[dim]
  return {
    sql: `SELECT ${key} AS key, count(DISTINCT s.person_id) AS visitors, count(*) AS visits,
            coalesce(sum(s.revenue), 0) AS revenue, coalesce(sum(s.orders), 0) AS orders,
            sum(CASE WHEN s.orders > 0 THEN 1 ELSE 0 END) AS converted
          FROM sessions s WHERE ${where.sql}${present ? ` AND ${present}` : ''}
          GROUP BY key ORDER BY visitors DESC, key LIMIT ?`,
    args: [...where.args, limit],
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Periods

const MINUTE = 60_000
const DAY = 86_400_000

export type Period = { from: string; to: string; prevFrom: string; prevTo: string; bucket: 'day' | 'hour'; buckets: string[]; prevBuckets: string[]; shift: string }

/**
 * The period a range covers in the viewer's time zone (`tzOffset` as Date.getTimezoneOffset gives it: minutes
 * behind UTC). Today is local midnight to now, by hour; N days are N local days ending today, by day. The previous
 * period is the same length right before it.
 */
export function periodOf(range: OverviewRange, tzOffset: number, now = Date.now()): Period {
  const offset = Math.max(-14 * 60, Math.min(14 * 60, Math.round(tzOffset))) * MINUTE
  const localNow = now - offset
  const localMidnight = Math.floor(localNow / DAY) * DAY
  const days = range === 'today' ? 1 : Number(range)
  const start = localMidnight - (days - 1) * DAY + offset
  const end = now + 1
  const length = range === 'today' ? DAY : days * DAY
  const prevStart = start - length
  const bucket = range === 'today' ? 'hour' : 'day'
  const step = bucket === 'hour' ? 3_600_000 : DAY
  const label = (t: number) => new Date(t - offset).toISOString().slice(0, bucket === 'hour' ? 13 : 10)
  const count = range === 'today' ? 24 : days
  const buckets = Array.from({ length: count }, (_, i) => label(start + i * step))
  const prevBuckets = Array.from({ length: count }, (_, i) => label(prevStart + i * step))
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    prevFrom: new Date(prevStart).toISOString(),
    prevTo: new Date(start).toISOString(),
    bucket,
    buckets,
    prevBuckets,
    // An explicit sign: "+300 minutes" / "-480 minutes".
    shift: `${offset > 0 ? '-' : '+'}${Math.abs(Math.round(offset / MINUTE))} minutes`,
  }
}
