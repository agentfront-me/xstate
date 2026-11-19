import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FREE_LIMITS, limitsFor } from '../billing/plans.ts'
import { ceiling, decide, pausedIn, weekOf } from './rules.ts'

const growth = limitsFor('growth', 0)

describe('ceiling', () => {
  it('allows 10% over, rounded down', () => {
    assert.equal(ceiling(1000), 1100)
    assert.equal(ceiling(5), 5)
    assert.equal(ceiling(1), 1)
  })
})

describe('limitsFor', () => {
  it('gives Growth 50 GB plus 1 GB per extra hundred, and a search cap of 100 per person', () => {
    assert.equal(growth.storageBytes, 50e9)
    assert.equal(limitsFor('growth', 50).storageBytes, 100e9)
    assert.equal(limitsFor('growth', 50).searchableEmails, 1_000_000)
    assert.equal(growth.mailboxes, null)
  })
  it('takes Custom limits from the override, unlimited otherwise', () => {
    const custom = limitsFor('custom', null, { audience: 2_000_000 })
    assert.equal(custom.audience, 2_000_000)
    assert.equal(custom.storageBytes, null)
  })
})

describe('weekOf', () => {
  it('names ISO weeks', () => {
    assert.equal(weekOf(Date.UTC(2026, 10, 19)), '2026-W47')
    assert.equal(weekOf(Date.UTC(2026, 0, 1)), '2026-W01')
    assert.equal(weekOf(Date.UTC(2027, 0, 1)), '2026-W53')
  })
})

describe('decide', () => {
  const free = { name: 'Acme', plan: 'free' as const }
  const used = (audience: number, storage = 0, emails = 0) => ({ audience, storage, emails })
  it('sends nothing under the limits', () => {
    assert.deepEqual(decide(free, FREE_LIMITS, used(500), '2026-11', '2026-W47', null), { notices: [], paused: false })
  })
  it('warns Free at 100% and pauses over 110%', () => {
    const at = decide(free, FREE_LIMITS, used(1000), '2026-11', '2026-W47', null)
    assert.deepEqual(at.notices.map((n) => n.key), ['audience:100:2026-11'])
    assert.equal(at.paused, false)
    const over = decide(free, FREE_LIMITS, used(1101), '2026-11', '2026-W47', null)
    assert.deepEqual(over.notices.map((n) => n.key), ['audience:110:2026-11'])
    assert.equal(over.paused, true)
  })
  it('stays paused for the rest of the month once paused', () => {
    assert.equal(decide(free, FREE_LIMITS, used(10), '2026-11', '2026-W47', '{"audiencePaused":"2026-11"}').paused, true)
    assert.equal(decide(free, FREE_LIMITS, used(10), '2026-12', '2026-W49', '{"audiencePaused":"2026-11"}').paused, false)
  })
  it('lifts the pause once the organization is on Growth', () => {
    assert.equal(decide({ name: 'Acme', plan: 'growth' }, growth, used(10), '2026-11', '2026-W47', '{"audiencePaused":"2026-11"}').paused, false)
  })
  it('emails Growth weekly while full, and never pauses it', () => {
    const r = decide({ name: 'Acme', plan: 'growth' }, growth, used(6000), '2026-11', '2026-W47', null)
    assert.deepEqual(r.notices.map((n) => n.key), ['audience:full:2026-W47'])
    assert.equal(r.paused, false)
  })
  it('warns about storage on any plan with a storage limit', () => {
    const r = decide({ name: 'Acme', plan: 'growth' }, growth, used(10, 56e9), '2026-11', '2026-W47', null)
    assert.deepEqual(r.notices.map((n) => n.key), ['storage:110:2026-11'])
  })
  it('warns Free when its emails run out', () => {
    const r = decide(free, FREE_LIMITS, used(10, 0, 4000), '2026-11', '2026-W47', null)
    assert.deepEqual(r.notices.map((n) => n.key), ['emails:100:2026-11'])
  })
  it('reads the pause flag safely', () => {
    assert.equal(pausedIn('nope', '2026-11'), false)
    assert.equal(pausedIn(null, '2026-11'), false)
  })
})
