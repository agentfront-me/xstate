import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createHmac } from 'node:crypto'
import { collector, track, userHash } from './events.ts'

const env = { XSTATE_SECRET_KEY: 'sk_live_test' }
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function captureFetch(status = 202) {
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response('{}', { status })
  }) as typeof fetch
  return calls
}

describe('userHash', () => {
  it('is hex HMAC-SHA256 of the user id, keyed with the secret key (what /v1/collect checks)', async () => {
    const expected = createHmac('sha256', env.XSTATE_SECRET_KEY).update('user-1').digest('hex')
    assert.equal(await userHash(env, 'user-1'), expected)
  })
  it('is null without the secret key', async () => {
    assert.equal(await userHash({}, 'user-1'), null)
  })
})

describe('track', () => {
  it('posts a server event with the secret key, user and org_id', async () => {
    const calls = captureFetch()
    const { background, flush } = collector()
    track(env, background, 'user-1', 'org-1', 'Member Invited', { role: 'admin' })
    await flush()
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://api.xstate.com/v1/collect')
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer sk_live_test')
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
      type: 'track',
      event: 'Member Invited',
      userId: 'user-1',
      domain: 'xstate.com',
      properties: { org_id: 'org-1', role: 'admin' },
    })
  })
  it('works out lazy properties in the background', async () => {
    const calls = captureFetch()
    const { background, flush } = collector()
    track(env, background, 'u', 'o', 'Agent Created', async () => ({ provider: 'anthropic' }))
    await flush()
    assert.equal(JSON.parse(calls[0]!.init.body as string).properties.provider, 'anthropic')
  })
  it('sends nothing without the secret key', async () => {
    const calls = captureFetch()
    const { background, flush } = collector()
    track({}, background, 'u', 'o', 'Alias Added', {})
    await flush()
    assert.equal(calls.length, 0)
  })
  it('never throws when collect fails or the properties do', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    const { background, flush } = collector()
    track(env, background, 'u', 'o', 'Alias Added', {})
    track(env, background, 'u', 'o', 'Agent Created', async () => {
      throw new Error('lookup failed')
    })
    await flush()
  })
})
