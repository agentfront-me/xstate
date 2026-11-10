// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { costOf, formatUsd, priceOf } from './prices.ts'

describe('prices', () => {
  it('prices listed models', () => {
    // 1M in + 1M out on Sonnet 5.5 = $2 + $10.
    assert.equal(costOf('anthropic', 'claude-sonnet-5-5', { input: 1_000_000, output: 1_000_000 }), 12)
    // The OpenAI run from the spike: 1,526 in / 133 out on gpt-5.4-mini.
    assert.equal(Math.round(costOf('openai', 'gpt-5.4-mini', { input: 1526, output: 133 }) * 1e6) / 1e6, 0.001743)
  })
  it('treats dated snapshots as their base model', () => {
    assert.equal(priceOf('anthropic', 'claude-haiku-4-5-20251001').input, 1)
    assert.equal(priceOf('openai', 'gpt-5-2025-08-07').listed, true)
  })
  it('prices unknown models at the provider’s highest rate', () => {
    const p = priceOf('openai', 'gpt-9-future')
    assert.equal(p.listed, false)
    assert.deepEqual([p.input, p.output], [30, 180])
    assert.deepEqual([priceOf('anthropic', 'claude-new').input, priceOf('anthropic', 'claude-new').output], [10, 50])
  })
  it('formats amounts', () => {
    assert.equal(formatUsd(0), '$0')
    assert.equal(formatUsd(0.00174), '$0.0017')
    assert.equal(formatUsd(0.0134), '$0.013')
    assert.equal(formatUsd(18.4), '$18.40')
    assert.equal(formatUsd(250.4), '$250')
  })
})
