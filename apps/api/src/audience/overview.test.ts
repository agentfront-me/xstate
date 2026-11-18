import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { breakdownQuery, periodOf, seriesQuery, sessionWhere, totalsQuery } from './overview.ts'

// The Overview SQL on a real SQLite, with the sessions and events columns the store has.
function db() {
  const d = new DatabaseSync(':memory:')
  d.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, person_id TEXT, domain TEXT, started_at TEXT, ended_at TEXT, pageviews INTEGER, events INTEGER,
    engaged_ms INTEGER, landing_path TEXT, exit_path TEXT, channel TEXT, referring_domain TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
    country TEXT, region TEXT, city TEXT, device_type TEXT, browser TEXT, os TEXT, revenue REAL, orders INTEGER)`)
  d.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, person_id TEXT, session_id TEXT, type TEXT, name TEXT, path TEXT, occurred_at TEXT)')
  const s = d.prepare(`INSERT INTO sessions VALUES (?, ?, 'shop.test', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'Chrome', 'macOS', ?, ?)`)
  // [id, person, start, end, pageviews, engaged_ms, landing, exit, channel, referrer, source, medium, campaign, country, device, revenue, orders]
  s.run('v1', 'a', '2026-11-10T10:00:00.000Z', '2026-11-10T10:05:00.000Z', 3, 60000, '/', '/cart', 'Paid search', 'google.com', 'google', 'cpc', 'fall', 'US', 'desktop', 96, 1)
  s.run('v2', 'a', '2026-11-11T10:00:00.000Z', '2026-11-11T10:00:02.000Z', 1, 2000, '/', '/', 'Direct', null, null, null, null, 'US', 'desktop', 0, 0)
  s.run('v3', 'b', '2026-11-11T12:00:00.000Z', '2026-11-11T12:00:01.000Z', 1, 1000, '/pricing', '/pricing', 'Social', 't.co', null, null, null, 'DE', 'mobile', 0, 0)
  s.run('old', 'c', '2026-10-01T12:00:00.000Z', '2026-10-01T12:10:00.000Z', 2, 0, '/', '/', 'Direct', null, null, null, null, 'US', 'mobile', 0, 0)
  const e = d.prepare("INSERT INTO events (person_id, session_id, type, name, path, occurred_at) VALUES (?, ?, ?, ?, ?, ?)")
  e.run('a', 'v1', 'page', '$pageview', '/', '2026-11-10T10:00:00.000Z')
  e.run('a', 'v1', 'page', '$pageview', '/cart', '2026-11-10T10:04:00.000Z')
  e.run('a', 'v1', 'track', 'Order Completed', null, '2026-11-10T10:05:00.000Z')
  e.run('b', 'v3', 'page', '$pageview', '/pricing', '2026-11-11T12:00:00.000Z')
  return d
}

const FROM = '2026-11-01T00:00:00.000Z'
const TO = '2026-11-20T00:00:00.000Z'

describe('overview', () => {
  it('totals visitors, visits, bounces, time and revenue', () => {
    const d = db()
    const q = totalsQuery(sessionWhere(FROM, TO, undefined, []))
    const t = d.prepare(q.sql).get(...q.args) as Record<string, number>
    assert.equal(t.visitors, 2)
    assert.equal(t.visits, 3)
    assert.equal(t.pageviews, 5)
    assert.equal(t.bounces, 2)
    assert.equal(Math.round(t.seconds), 303)
    assert.equal(t.revenue, 96)
    assert.equal(t.orders, 1)
  })

  it('filters by a dimension, a viewed page, and a site', () => {
    const d = db()
    const count = (filters: Parameters<typeof sessionWhere>[3], domain?: string) => {
      const q = totalsQuery(sessionWhere(FROM, TO, domain, filters))
      return (d.prepare(q.sql).get(...q.args) as { visits: number }).visits
    }
    assert.equal(count([{ dim: 'channel', value: 'Paid search' }]), 1)
    assert.equal(count([{ dim: 'country', value: 'US' }, { dim: 'device', value: 'desktop' }]), 2)
    assert.equal(count([{ dim: 'page', value: '/cart' }]), 1)
    assert.equal(count([{ dim: 'campaign', value: 'google|cpc|fall' }]), 1)
    assert.equal(count([], 'other.test'), 0)
  })

  it('breaks down by visits and by events', () => {
    const d = db()
    const w = sessionWhere(FROM, TO, undefined, [])
    const rows = (dim: Parameters<typeof breakdownQuery>[0]) => {
      const q = breakdownQuery(dim, w, 10, FROM, TO)
      return d.prepare(q.sql).all(...q.args) as Record<string, string | number>[]
    }
    assert.deepEqual(rows('channel').map((r) => r.key), ['Direct', 'Paid search', 'Social'])
    assert.deepEqual(rows('referrer').map((r) => r.key), ['google.com', 't.co'])
    assert.deepEqual(rows('campaign').map((r) => r.key), ['google|cpc|fall'])
    assert.equal(rows('channel').find((r) => r.key === 'Paid search')!.revenue, 96)
    assert.deepEqual(rows('page').map((r) => [r.key, r.visitors]), [['/', 1], ['/cart', 1], ['/pricing', 1]])
    assert.deepEqual(rows('event').map((r) => [r.key, r.count]), [['Order Completed', 1]])
  })

  it('buckets by local day', () => {
    const d = db()
    const q = seriesQuery(sessionWhere(FROM, TO, undefined, []), 'day', '+300 minutes')
    const rows = d.prepare(q.sql).all(...q.args) as { b: string; visits: number }[]
    assert.deepEqual(rows.map((r) => [r.b, r.visits]), [['2026-11-10', 1], ['2026-11-11', 2]])
  })

  it('works out periods in the viewer’s time zone', () => {
    // 2026-11-18 16:00 UTC, viewer in Pakistan (UTC+5: getTimezoneOffset is -300).
    const now = Date.parse('2026-11-18T16:00:00.000Z')
    const p = periodOf('7', -300, now)
    assert.equal(p.from, '2026-11-11T19:00:00.000Z')
    assert.equal(p.prevFrom, '2026-11-04T19:00:00.000Z')
    assert.equal(p.prevTo, p.from)
    assert.deepEqual([p.buckets[0], p.buckets.at(-1), p.buckets.length], ['2026-11-12', '2026-11-18', 7])
    assert.equal(p.shift, '+300 minutes')
    assert.equal(periodOf('7', 480, now).shift, '-480 minutes')
    const today = periodOf('today', -300, now)
    assert.equal(today.from, '2026-11-17T19:00:00.000Z')
    assert.deepEqual([today.buckets[0], today.buckets.length, today.bucket], ['2026-11-18T00', 24, 'hour'])
  })
})
