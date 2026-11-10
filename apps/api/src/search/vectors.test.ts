// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { upsertRows } from './vectors.ts'

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d:${i}`, values: [0], namespace: 'o' }))

function fakeEnv(fail: (call: number) => Error | null) {
  const calls: number[] = []
  const index = {
    async upsert(batch: unknown[]) {
      calls.push(batch.length)
      const err = fail(calls.length)
      if (err) throw err
    },
  }
  return { env: { ENVIRONMENT: 'production', SEARCH: index, SEARCH_DEV: index } as never, calls }
}

describe('upsertRows', () => {
  it('writes in as few calls as Vectorize allows', async () => {
    const { env, calls } = fakeEnv(() => null)
    await upsertRows(env, rows(2500) as never, async () => {})
    assert.deepEqual(calls, [1000, 1000, 500])
  })

  it('waits and retries a write refused for rate, with the same rows', async () => {
    const { env, calls } = fakeEnv((n) => (n <= 2 ? new Error('VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests') : null))
    const waits: number[] = []
    await upsertRows(env, rows(10) as never, async (ms) => void waits.push(ms))
    assert.deepEqual(calls, [10, 10, 10])
    assert.equal(waits.length, 2)
  })

  it('gives up after its retries, and at once on other errors', async () => {
    const limited = fakeEnv(() => new Error('Too Many Requests'))
    await assert.rejects(upsertRows(limited.env, rows(1) as never, async () => {}), /Too Many Requests/)
    assert.equal(limited.calls.length, 5)
    const broken = fakeEnv(() => new Error('dimension mismatch'))
    await assert.rejects(upsertRows(broken.env, rows(1) as never, async () => {}), /dimension/)
    assert.equal(broken.calls.length, 1)
  })
})
