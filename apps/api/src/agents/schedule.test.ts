// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describe as label, instantOf, nextRun, parseCron, validate, wallClock } from './schedule.ts'

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString())
const at = (s: string) => Date.parse(s)

describe('instantOf', () => {
  it('turns London summer and winter wall times into the right UTC', () => {
    assert.equal(iso(instantOf(2026, 7, 1, 9, 0, 'Europe/London')), '2026-07-01T08:00:00.000Z')
    assert.equal(iso(instantOf(2026, 12, 1, 9, 0, 'Europe/London')), '2026-12-01T09:00:00.000Z')
  })
  it('moves a time skipped by the spring jump to after it', () => {
    // 2026-03-29 01:30 does not exist in London (01:00 → 02:00).
    const t = instantOf(2026, 3, 29, 1, 30, 'Europe/London')
    assert.equal(wallClock(t, 'Europe/London').h, 2)
  })
  it('takes the first of a time that happens twice in autumn', () => {
    // 2026-10-25 01:30 happens at 00:30Z (BST) and 01:30Z (GMT).
    assert.equal(iso(instantOf(2026, 10, 25, 1, 30, 'Europe/London')), '2026-10-25T00:30:00.000Z')
  })
  it('handles zones ahead of UTC', () => {
    assert.equal(iso(instantOf(2026, 11, 10, 9, 0, 'Asia/Karachi')), '2026-11-10T04:00:00.000Z')
  })
})

describe('nextRun', () => {
  it('daily: later today, else tomorrow', () => {
    const spec = { frequency: 'daily' as const, time: '09:00', timezone: 'Europe/London' }
    assert.equal(iso(nextRun(spec, at('2026-11-10T08:00:00Z'))), '2026-11-10T09:00:00.000Z')
    assert.equal(iso(nextRun(spec, at('2026-11-10T09:00:00Z'))), '2026-11-11T09:00:00.000Z')
  })
  it('daily keeps 09:00 local across the DST change', () => {
    const spec = { frequency: 'daily' as const, time: '09:00', timezone: 'Europe/London' }
    assert.equal(iso(nextRun(spec, at('2026-10-24T09:30:00Z'))), '2026-10-25T09:00:00.000Z')
    assert.equal(iso(nextRun(spec, at('2026-10-23T09:30:00Z'))), '2026-10-24T08:00:00.000Z')
  })
  it('weekly: the next listed weekday', () => {
    // 2026-11-10 is a Tuesday.
    const spec = { frequency: 'weekly' as const, time: '09:00', weekdays: [1], timezone: 'Europe/London' }
    assert.equal(iso(nextRun(spec, at('2026-11-10T12:00:00Z'))), '2026-11-16T09:00:00.000Z')
  })
  it('once: in the future, or never', () => {
    const spec = { frequency: 'once' as const, at: '2026-11-12T10:00', timezone: 'America/New_York' }
    assert.equal(iso(nextRun(spec, at('2026-11-10T00:00:00Z'))), '2026-11-12T15:00:00.000Z')
    assert.equal(nextRun(spec, at('2026-11-13T00:00:00Z')), null)
  })
  it('interval: from the last run, never in the past', () => {
    const spec = { frequency: 'interval' as const, everyMinutes: 15, timezone: 'UTC' }
    assert.equal(iso(nextRun(spec, at('2026-11-10T10:00:00Z'))), '2026-11-10T10:15:00.000Z')
    assert.equal(iso(nextRun(spec, at('2026-11-10T10:20:00Z'), at('2026-11-10T10:00:00Z'))), '2026-11-10T10:30:00.000Z')
  })
  it('cron in the trigger time zone', () => {
    const spec = { frequency: 'cron' as const, cron: '0 9 * * 1', timezone: 'Europe/London' }
    assert.equal(iso(nextRun(spec, at('2026-11-10T00:00:00Z'))), '2026-11-16T09:00:00.000Z')
    const every15 = { frequency: 'cron' as const, cron: '*/15 * * * *', timezone: 'UTC' }
    assert.equal(iso(nextRun(every15, at('2026-11-10T10:07:00Z'))), '2026-11-10T10:15:00.000Z')
  })
  it('cron with both day fields matches either', () => {
    // The 1st of the month or any Friday: after Tue 2026-11-10 comes Fri 2026-11-13.
    const spec = { frequency: 'cron' as const, cron: '0 8 1 * 5', timezone: 'UTC' }
    assert.equal(iso(nextRun(spec, at('2026-11-10T00:00:00Z'))), '2026-11-13T08:00:00.000Z')
  })
})

describe('validate and parse', () => {
  it('rejects bad input with a readable reason', () => {
    assert.match(validate({ frequency: 'daily', time: '25:00', timezone: 'UTC' })!, /time/)
    assert.match(validate({ frequency: 'daily', time: '09:00', timezone: 'Mars/Base' })!, /time zone/)
    assert.match(validate({ frequency: 'interval', everyMinutes: 1, timezone: 'UTC' })!, /5 minutes/)
    assert.match(validate({ frequency: 'cron', cron: '* * *', timezone: 'UTC' })!, /five fields/)
    assert.equal(validate({ frequency: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5], timezone: 'UTC' }), null)
  })
  it('parses ranges, lists and steps', () => {
    const c = parseCron('0,30 9-17/2 * * 1-5')
    assert.deepEqual(c.minutes, [0, 30])
    assert.deepEqual(c.hours, [9, 11, 13, 15, 17])
    assert.deepEqual([...c.dows], [1, 2, 3, 4, 5])
  })
  it('describes schedules', () => {
    assert.equal(label({ frequency: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5], timezone: 'UTC' }), 'Weekdays at 09:00')
    assert.equal(label({ frequency: 'interval', everyMinutes: 120, timezone: 'UTC' }), 'Every 2 hours')
  })
})
