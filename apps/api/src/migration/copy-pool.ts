// Running many downloads at once without running out of memory. See mail.ts.
//
// ByteBudget caps the bytes in flight: each message reserves its size before it's downloaded and gives it back once
// uploaded, so many small messages run together while a big one waits until it can run nearly alone. Waiters are
// served in order, so a big message isn't starved by a stream of small ones. One budget is shared by every job in
// an isolate (Workers may run several queue jobs in one), which is what the 128 MB memory limit applies to.
//
// runPool hands items to up to `max` workers. Its concurrency drops by half when Google says to slow down
// (slowDown) and climbs back one at a time after a run of successes.
//
// No Workers-only imports here: the tests run it under Node.

export class ByteBudget {
  readonly limit: number
  private used = 0
  private waiting: { bytes: number; grant: () => void }[] = []

  constructor(limit: number) {
    this.limit = limit
  }

  /** Waits until `bytes` fit (anything over the limit waits for the budget to be empty), then returns a release. */
  async acquire(bytes: number): Promise<() => void> {
    const want = Math.min(Math.max(bytes, 0), this.limit)
    if (!this.waiting.length && this.fits(want)) {
      this.used += want
    } else {
      await new Promise<void>((grant) => this.waiting.push({ bytes: want, grant }))
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.used -= want
      this.drain()
    }
  }

  get inUse(): number {
    return this.used
  }

  private fits(bytes: number) {
    return this.used === 0 || this.used + bytes <= this.limit
  }

  private drain() {
    while (this.waiting.length && this.fits(this.waiting[0]!.bytes)) {
      const next = this.waiting.shift()!
      this.used += next.bytes
      next.grant()
    }
  }
}

export type PoolControl = {
  /** Google asked to slow down: halve the concurrency for a while. */
  slowDown(): void
  /** Whether the pool is stopping (an error elsewhere, or stop()), so long work can give up early. */
  readonly stopping: boolean
  /** Stops handing out items; work already running finishes. */
  stop(): void
}

/** Successes in a row before the concurrency goes back up by one. */
const RECOVER_AFTER = 20

/**
 * Runs `work` for each item with up to `max` at once (never fewer than `min`). Stops handing out items on the first
 * error, lets running work finish, then throws that error. Returns how many items were started.
 */
export async function runPool<T>(items: T[], options: { max: number; min?: number }, work: (item: T, ctl: PoolControl) => Promise<void>): Promise<number> {
  const min = Math.max(1, options.min ?? 1)
  let limit = Math.max(min, options.max)
  let active = 0
  let next = 0
  let streak = 0
  let stopping = false
  let failure: { err: unknown } | null = null
  const ctl: PoolControl = {
    slowDown() {
      limit = Math.max(min, Math.floor(limit / 2))
      streak = 0
    },
    get stopping() {
      return stopping
    },
    stop() {
      stopping = true
    },
  }

  await new Promise<void>((done) => {
    const pump = () => {
      while (!stopping && active < limit && next < items.length) {
        const item = items[next++]!
        active++
        work(item, ctl).then(
          () => {
            if (++streak >= RECOVER_AFTER && limit < options.max) {
              limit++
              streak = 0
            }
          },
          (err) => {
            if (!failure) failure = { err }
            stopping = true
          },
        ).finally(() => {
          active--
          pump()
        })
      }
      if (active === 0 && (stopping || next >= items.length)) done()
    }
    pump()
  })
  if (failure) throw (failure as { err: unknown }).err
  return next
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
