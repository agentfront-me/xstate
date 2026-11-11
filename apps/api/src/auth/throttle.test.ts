// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loginThrottled, registerThrottled, type ThrottleEnv } from './throttle.ts'

/** A rate limiter that allows `limit` calls per key, and records the keys it saw. */
function limiter(limit: number) {
  const counts = new Map<string, number>()
  const seen: string[] = []
  return {
    seen,
    async limit({ key }: { key: string }) {
      seen.push(key)
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      return { success: n <= limit }
    },
  }
}

function fakeEnv() {
  const env = { LOGIN_IP_RATE: limiter(10), LOGIN_EMAIL_RATE: limiter(5), REGISTER_IP_RATE: limiter(5) }
  return { env, throttleEnv: env as unknown as ThrottleEnv }
}

const allowed = async (p: Promise<string | null>) => assert.equal(await p, null)
const refused = async (p: Promise<string | null>) => assert.match((await p) ?? '', /Too many/)

describe('loginThrottled', () => {
  it('allows 5 attempts per email, then refuses whatever the IP', async () => {
    const { throttleEnv } = fakeEnv()
    for (let i = 0; i < 5; i++) await allowed(loginThrottled(throttleEnv, 'a@x.com', `10.0.0.${i}`))
    await refused(loginThrottled(throttleEnv, 'a@x.com', '10.0.0.99'))
    // Another account is unaffected.
    await allowed(loginThrottled(throttleEnv, 'b@x.com', '10.0.0.99'))
  })

  it('allows 10 attempts per IP across emails, then refuses', async () => {
    const { throttleEnv } = fakeEnv()
    for (let i = 0; i < 10; i++) await allowed(loginThrottled(throttleEnv, `u${i}@x.com`, '1.2.3.4'))
    await refused(loginThrottled(throttleEnv, 'fresh@x.com', '1.2.3.4'))
    await allowed(loginThrottled(throttleEnv, 'fresh@x.com', '5.6.7.8'))
  })

  it('applies only the email limit when there is no IP', async () => {
    const { env, throttleEnv } = fakeEnv()
    await loginThrottled(throttleEnv, 'a@x.com', undefined)
    assert.deepEqual(env.LOGIN_IP_RATE.seen, [])
    assert.deepEqual(env.LOGIN_EMAIL_RATE.seen, ['a@x.com'])
  })
})

describe('registerThrottled', () => {
  it('allows 5 sign-ups per IP, then refuses', async () => {
    const { throttleEnv } = fakeEnv()
    for (let i = 0; i < 5; i++) await allowed(registerThrottled(throttleEnv, '1.2.3.4'))
    await refused(registerThrottled(throttleEnv, '1.2.3.4'))
    await allowed(registerThrottled(throttleEnv, '5.6.7.8'))
  })

  it('does nothing without an IP', async () => {
    const { env, throttleEnv } = fakeEnv()
    await registerThrottled(throttleEnv, undefined)
    assert.deepEqual(env.REGISTER_IP_RATE.seen, [])
  })
})
