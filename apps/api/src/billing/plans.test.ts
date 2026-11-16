import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'
import { verifySignature } from './paddle.ts'
import { effectivePlan, planOfPrice, priceIds, seatsFor } from './plans.ts'

const ids = { pro: { month: 'pri_pm', year: 'pri_py' }, team: { month: 'pri_tm', year: 'pri_ty' } }

describe('priceIds', () => {
  it('reads an object or a JSON string', () => {
    assert.deepEqual(priceIds(ids), ids)
    assert.deepEqual(priceIds(JSON.stringify(ids)), ids)
  })
  it('is null when missing or incomplete', () => {
    assert.equal(priceIds(''), null)
    assert.equal(priceIds(undefined), null)
    assert.equal(priceIds('{nope'), null)
    assert.equal(priceIds({ pro: ids.pro }), null)
    assert.equal(priceIds({ ...ids, team: { month: 'x', year: 'pri_ty' } }), null)
  })
})

describe('planOfPrice', () => {
  it('maps price ids back to plan and interval', () => {
    assert.deepEqual(planOfPrice(ids, 'pri_ty'), { plan: 'team', interval: 'year' })
    assert.equal(planOfPrice(ids, 'pri_other'), null)
  })
})

describe('effectivePlan', () => {
  it('keeps the plan while the subscription bills, including past due', () => {
    for (const s of ['active', 'trialing', 'past_due']) assert.equal(effectivePlan(s, 'pro'), 'pro')
  })
  it('falls back to free when paused, cancelled or unknown', () => {
    for (const s of ['paused', 'canceled', null]) assert.equal(effectivePlan(s, 'team'), 'free')
    assert.equal(effectivePlan('active', null), 'free')
  })
})

describe('seatsFor', () => {
  it('bills at least one seat', () => {
    assert.equal(seatsFor(0), 1)
    assert.equal(seatsFor(7), 7)
  })
})

describe('verifySignature', () => {
  const secret = 'pdl_ntfset_test'
  const body = '{"event_type":"subscription.created"}'
  const sign = (ts: number, s = secret) => createHmac('sha256', s).update(`${ts}:${body}`).digest('hex')
  const now = 1_800_000_000

  it('accepts a fresh, correct signature', async () => {
    assert.equal(await verifySignature(secret, `ts=${now};h1=${sign(now)}`, body, now), true)
  })
  it('accepts either signature during a secret rotation', async () => {
    assert.equal(await verifySignature(secret, `ts=${now};h1=${sign(now, 'old')};h1=${sign(now)}`, body, now), true)
  })
  it('refuses a wrong secret, a changed body or an old timestamp', async () => {
    assert.equal(await verifySignature(secret, `ts=${now};h1=${sign(now, 'other')}`, body, now), false)
    assert.equal(await verifySignature(secret, `ts=${now};h1=${sign(now)}`, body + ' ', now), false)
    assert.equal(await verifySignature(secret, `ts=${now - 600};h1=${sign(now - 600)}`, body, now), false)
    assert.equal(await verifySignature(secret, '', body, now), false)
  })
})
