// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ByteBudget, runPool, sleep } from './copy-pool.ts'

describe('ByteBudget', () => {
  it('lets small items share it and makes a big one wait to run alone', async () => {
    const budget = new ByteBudget(100)
    const a = await budget.acquire(40)
    const b = await budget.acquire(40)
    assert.equal(budget.inUse, 80)
    let bigIn = false
    const big = budget.acquire(500).then((r) => ((bigIn = true), r))
    await sleep(5)
    assert.equal(bigIn, false)
    a()
    await sleep(5)
    assert.equal(bigIn, false)
    b()
    const release = await big
    assert.equal(budget.inUse, 100)
    release()
    release()
    assert.equal(budget.inUse, 0)
  })

  it('serves waiters in order, so small ones do not starve a big one', async () => {
    const budget = new ByteBudget(100)
    const first = await budget.acquire(60)
    const order: string[] = []
    const big = budget.acquire(80).then((r) => (order.push('big'), r))
    const small = budget.acquire(10).then((r) => (order.push('small'), r))
    first()
    ;(await big)()
    ;(await small)()
    assert.deepEqual(order, ['big', 'small'])
  })
})

describe('runPool', () => {
  it('runs everything, never more than max at once', async () => {
    let running = 0
    let peak = 0
    const done: number[] = []
    await runPool([...Array(30).keys()], { max: 4 }, async (n) => {
      peak = Math.max(peak, ++running)
      await sleep(1)
      running--
      done.push(n)
    })
    assert.equal(done.length, 30)
    assert.equal(peak, 4)
  })

  it('halves its concurrency when told to slow down', async () => {
    let running = 0
    let peakAfter = 0
    let slowed = false
    await runPool([...Array(40).keys()], { max: 8, min: 2 }, async (n, ctl) => {
      running++
      if (n === 0) {
        ctl.slowDown()
        slowed = true
      }
      await sleep(2)
      if (slowed && n > 10 && n < 20) peakAfter = Math.max(peakAfter, running)
      running--
    })
    assert.ok(peakAfter <= 4, `ran ${peakAfter} at once after slowing down`)
  })

  it('stops handing out work on an error and throws it', async () => {
    const started: number[] = []
    await assert.rejects(
      runPool([...Array(50).keys()], { max: 3 }, async (n) => {
        started.push(n)
        await sleep(1)
        if (n === 2) throw new Error('boom')
      }),
      /boom/,
    )
    assert.ok(started.length < 50)
  })
})
