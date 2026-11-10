// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connectorToolName, describeCondition, matches } from './rules.ts'

describe('matches', () => {
  it('compares numbers, also when sent as strings', () => {
    assert.equal(matches({ field: 'amount', op: 'gt', value: 100 }, { amount: 240 }), true)
    assert.equal(matches({ field: 'amount', op: 'gt', value: 100 }, { amount: 40 }), false)
    assert.equal(matches({ field: 'amount', op: 'gt', value: '100' }, { amount: '240.50' }), true)
    assert.equal(matches({ field: 'amount', op: 'lt', value: 10 }, { amount: 3 }), true)
  })
  it('reads nested fields', () => {
    assert.equal(matches({ field: 'order.total', op: 'gt', value: 100 }, { order: { total: 99 } }), false)
  })
  it('asks when it can’t judge (missing field, not a number)', () => {
    assert.equal(matches({ field: 'amount', op: 'gt', value: 100 }, {}), true)
    assert.equal(matches({ field: 'amount', op: 'gt', value: 100 }, { amount: 'lots' }), true)
  })
  it('eq and contains ignore case', () => {
    assert.equal(matches({ field: 'currency', op: 'eq', value: 'usd' }, { currency: 'USD' }), true)
    assert.equal(matches({ field: 'to', op: 'contains', value: '@gmail.com' }, { to: [{ email: 'A@Gmail.com' }] }), true)
    assert.equal(matches({ field: 'to', op: 'contains', value: '@acme.test' }, { to: [{ email: 'a@gmail.com' }] }), false)
  })
  it('describes conditions', () => assert.equal(describeCondition({ field: 'amount', op: 'gt', value: 100 }), 'amount > 100'))
})

describe('connectorToolName', () => {
  it('makes provider-safe, unique names', () => {
    const taken = new Set<string>()
    assert.equal(connectorToolName('Fake Shop!', 'create.refund', taken), 'fake_shop__create_refund')
    assert.equal(connectorToolName('Fake Shop!', 'create.refund', taken), 'fake_shop__create_refund_2')
    assert.match(connectorToolName('x'.repeat(80), 'y'.repeat(80), taken), /^[a-zA-Z0-9_-]{1,64}$/)
  })
})
