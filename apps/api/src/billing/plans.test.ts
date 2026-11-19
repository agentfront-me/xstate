import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clampExtra, effectivePlan, extraHundredsFor, growthPriceCents, growthSize, isLive, MAX_EXTRA_HUNDREDS } from './plans.ts'

describe('growth sizes', () => {
  it('starts at 5,000 people for $49', () => {
    assert.equal(growthSize(0), 5000)
    assert.equal(growthPriceCents(0), 4900)
  })
  it('adds 100 people and $1 per extra hundred', () => {
    assert.equal(growthSize(50), 10_000)
    assert.equal(growthPriceCents(50), 9900)
  })
  it('stops at 1,000,000 people', () => {
    assert.equal(growthSize(MAX_EXTRA_HUNDREDS + 10), 1_000_000)
    assert.equal(growthPriceCents(MAX_EXTRA_HUNDREDS), 999_900)
  })
  it('rounds people up to the next hundred', () => {
    assert.equal(extraHundredsFor(3000), 0)
    assert.equal(extraHundredsFor(5001), 1)
    assert.equal(extraHundredsFor(10_000), 50)
  })
  it('clamps nonsense', () => {
    assert.equal(clampExtra(-3), 0)
    assert.equal(clampExtra(Number.NaN), 0)
    assert.equal(clampExtra(2.4), 2)
  })
})

describe('effectivePlan', () => {
  it('is growth only while the subscription bills', () => {
    assert.equal(effectivePlan('free', 'active'), 'growth')
    assert.equal(effectivePlan('free', 'trialing'), 'growth')
    assert.equal(effectivePlan('growth', 'past_due'), 'growth')
    assert.equal(effectivePlan('growth', 'canceled'), 'free')
    assert.equal(effectivePlan('growth', 'paused'), 'free')
    assert.equal(effectivePlan('free', null), 'free')
  })
  it('leaves custom alone', () => {
    assert.equal(effectivePlan('custom', null), 'custom')
    assert.equal(effectivePlan('custom', 'canceled'), 'custom')
  })
  it('knows which statuses bill', () => {
    assert.equal(isLive('active'), true)
    assert.equal(isLive('incomplete'), false)
    assert.equal(isLive(undefined), false)
  })
})
