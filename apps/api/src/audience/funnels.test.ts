import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { funnelInput, funnelQuery, globOf, summarize } from './funnels.ts'

// Runs the funnel SQL on a real SQLite with the events columns the store has.
function db(events: [person: string, name: string, type: string, path: string | null, at: string, domain?: string][]) {
  const d = new DatabaseSync(':memory:')
  d.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, person_id TEXT, type TEXT, name TEXT, path TEXT, domain TEXT, occurred_at TEXT)')
  const ins = d.prepare('INSERT INTO events (person_id, name, type, path, occurred_at, domain) VALUES (?, ?, ?, ?, ?, ?)')
  for (const [p, n, t, path, at, domain] of events) ins.run(p, n, t, path, at, domain ?? 'shop.test')
  return d
}

const T = (day: number, hour = 0) => new Date(Date.UTC(2026, 10, day, hour)).toISOString()

describe('funnels', () => {
  const funnel = funnelInput.parse({
    name: 'Checkout',
    steps: [{ type: 'page', match: '/products/*' }, { type: 'track', match: 'Added to Cart' }, { type: 'track', match: 'Order Completed' }],
    windowDays: 7,
  })

  it('counts people step by step, in order and within the window', () => {
    const d = db([
      // a: does everything, an hour apart
      ['a', '$pageview', 'page', '/products/linen', T(10, 0)],
      ['a', 'Added to Cart', 'track', null, T(10, 1)],
      ['a', 'Order Completed', 'track', null, T(10, 2)],
      // b: adds to cart before viewing a product (doesn't count), then again after
      ['b', 'Added to Cart', 'track', null, T(10, 0)],
      ['b', '$pageview', 'page', '/products/tote', T(10, 3)],
      ['b', 'Added to Cart', 'track', null, T(10, 5)],
      // c: orders, but 10 days after the first product view: outside the 7-day window
      ['c', '$pageview', 'page', '/products/x', T(1, 0)],
      ['c', 'Added to Cart', 'track', null, T(2, 0)],
      ['c', 'Order Completed', 'track', null, T(11, 0)],
      // d: never viewed a product page
      ['d', '$pageview', 'page', '/pricing', T(10, 0)],
      ['d', 'Order Completed', 'track', null, T(10, 1)],
    ])
    const q = funnelQuery(funnel, T(1), undefined)
    const rows = d.prepare(q.sql).all(...q.args) as Record<string, string | null>[]
    const r = summarize(rows, 3, 30)
    assert.deepEqual(r.steps.map((s) => s.people), [3, 3, 1])
    assert.deepEqual(r.steps.map((s) => s.dropped), [null, 0, 2])
    assert.equal(r.steps[1]!.medianSeconds, 7200)
    assert.equal(r.steps[2]!.medianSeconds, 3600)
    assert.equal(Math.round(r.conversion * 100), 33)
  })

  it('scopes to a site and to the range', () => {
    const d = db([
      ['a', '$pageview', 'page', '/products/1', T(10), 'shop.test'],
      ['b', '$pageview', 'page', '/products/1', T(10), 'other.test'],
      ['c', '$pageview', 'page', '/products/1', T(1), 'shop.test'],
    ])
    const q = funnelQuery(funnel, T(5), 'shop.test')
    assert.equal((d.prepare(q.sql).all(...q.args) as unknown[]).length, 1)
  })

  it('validates steps and treats only * as a wildcard', () => {
    assert.throws(() => funnelInput.parse({ name: 'x', steps: [{ type: 'page', match: '/a' }] }))
    assert.throws(() => funnelInput.parse({ name: 'x', steps: [{ type: 'page', match: 'a' }, { type: 'track', match: 'b' }] }))
    assert.throws(() => funnelInput.parse({ name: 'x', steps: [{ type: 'email', match: '$email_opened' }, { type: 'track', match: 'b' }] }))
    assert.equal(globOf('/a?b[1]/*'), '/a[?]b[[]1[]]/*')
  })
})
