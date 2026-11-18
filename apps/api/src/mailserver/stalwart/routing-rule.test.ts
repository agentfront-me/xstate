// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { STORE_RULE_MARKER, storeRuleDomains, withStoreRule, type StalwartExpression } from './routing-rule.ts'

// Production's route and schedule as recorded in docs/stalwart-api.md (relay through SES for outside domains).
const route: StalwartExpression = { match: { '0': { if: 'is_local_domain(rcpt_domain)', then: "'local'" } }, else: "'ses'" }
const schedule: StalwartExpression = {
  match: {
    '0': { if: 'is_local_domain(rcpt_domain)', then: "'local'" },
    '1': { if: "source == 'dsn'", then: "'dsn'" },
    '2': { if: "source == 'report'", then: "'report'" },
  },
  else: "'remote'",
}

describe('withStoreRule', () => {
  it('puts our rule first, sending the domains where outside mail goes', () => {
    const r = withStoreRule(route, ['99events.com'])
    assert.deepEqual(r.match['0'], { if: `${STORE_RULE_MARKER} && (rcpt_domain == '99events.com')`, then: "'ses'" })
    assert.deepEqual(r.match['1'], route.match['0'])
    assert.equal(r.else, "'ses'")
    const s = withStoreRule(schedule, ['99events.com'])
    assert.equal(s.match['0']!.then, "'remote'")
    assert.deepEqual([s.match['1'], s.match['2'], s.match['3']], [schedule.match['0'], schedule.match['1'], schedule.match['2']])
  })

  it('replaces its own rule instead of adding another, and keeps the domains sorted and unique', () => {
    const once = withStoreRule(route, ['b.com', 'a.com'])
    const twice = withStoreRule(once, ['A.com', 'c.com', 'a.com'])
    assert.equal(Object.keys(twice.match).length, 2)
    assert.equal(twice.match['0']!.if, `${STORE_RULE_MARKER} && (rcpt_domain == 'a.com' || rcpt_domain == 'c.com')`)
    assert.deepEqual(storeRuleDomains(twice), ['a.com', 'c.com'])
  })

  it('removes its rule when no domain is store-held, leaving the rest as it was', () => {
    assert.deepEqual(withStoreRule(withStoreRule(schedule, ['a.com']), []), schedule)
    assert.deepEqual(storeRuleDomains(route), [])
  })

  it("never touches someone else's rules, and refuses names that could break the expression", () => {
    const custom: StalwartExpression = { match: { '0': { if: "rcpt_domain == 'special.com'", then: "'mx'" }, ...{ '1': route.match['0']! } }, else: "'ses'" }
    const r = withStoreRule(custom, ["x.com' || true || 'y", 'ok.com'])
    assert.equal(r.match['0']!.if, `${STORE_RULE_MARKER} && (rcpt_domain == 'ok.com')`)
    assert.deepEqual([r.match['1'], r.match['2']], [custom.match['0'], custom.match['1']])
  })
})
