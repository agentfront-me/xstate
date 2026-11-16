import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { ipInCidrs, paddleWebhookCidrs, resetPaddleIpCache } from './ips.ts'

const LIVE = ['34.237.3.244/32', '34.195.105.136/32']

describe('ipInCidrs', () => {
  it('matches only listed /32 addresses', () => {
    assert.equal(ipInCidrs('34.237.3.244', LIVE), true)
    assert.equal(ipInCidrs('34.237.3.245', LIVE), false)
  })
  it('handles wider ranges and rejects junk', () => {
    assert.equal(ipInCidrs('10.1.2.3', ['10.0.0.0/8']), true)
    assert.equal(ipInCidrs('11.0.0.1', ['10.0.0.0/8']), false)
    assert.equal(ipInCidrs('', LIVE), false)
    assert.equal(ipInCidrs('::1', LIVE), false)
    assert.equal(ipInCidrs('34.237.3.999', LIVE), false)
  })
})

describe('paddleWebhookCidrs', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    resetPaddleIpCache()
  })
  it('fetches, caches, and falls back to the stale list when a refresh fails', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(JSON.stringify({ data: { ipv4_cidrs: LIVE } }))
    }) as typeof fetch
    assert.deepEqual(await paddleWebhookCidrs('https://api.paddle.com', 0), LIVE)
    assert.deepEqual(await paddleWebhookCidrs('https://api.paddle.com', 1000), LIVE)
    assert.equal(calls, 1)
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
    assert.deepEqual(await paddleWebhookCidrs('https://api.paddle.com', 2 * 60 * 60 * 1000), LIVE)
  })
  it('returns null when nothing could ever be loaded', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch
    assert.equal(await paddleWebhookCidrs('https://api.paddle.com', 0), null)
  })
})
