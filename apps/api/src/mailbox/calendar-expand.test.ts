// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { JmapEvent } from '../mailserver/stalwart/calendar'
import { applyPatch, changesSchedule, expand, occurrenceId, parseOccurrenceId, timeColumns, toRrule } from './calendar-expand.ts'

const ms = (iso: string) => Date.parse(iso)
const base = (over: Partial<JmapEvent>): JmapEvent => ({ id: 'E1', calendarIds: { c1: true }, title: 'Standup', start: '2026-03-02T09:00:00', duration: 'PT30M', timeZone: 'America/New_York', ...over })
const starts = (list: JmapEvent[]) => list.map((e) => e.utcStart)

describe('expand', () => {
  it('keeps the local time across a daylight-saving change', () => {
    const weekly = base({ recurrenceRule: { frequency: 'weekly' } })
    const got = expand(weekly, ms('2026-03-01T00:00:00Z'), ms('2026-03-15T00:00:00Z'))
    // 9:00 in New York: EST (UTC-5) on 2 March, EDT (UTC-4) from 8 March.
    assert.deepEqual(starts(got), ['2026-03-02T14:00:00Z', '2026-03-09T13:00:00Z'])
    assert.equal(got[1]!.utcEnd, '2026-03-09T13:30:00Z')
    assert.equal(got[1]!.baseEventId, 'E1')
    assert.equal(got[1]!.recurrenceId, '2026-03-09T09:00:00')
    assert.equal(got[1]!.recurrenceRule, undefined)
  })

  it('expands "the second Tuesday of every month"', () => {
    const monthly = base({ start: '2026-03-10T09:30:00', recurrenceRule: { frequency: 'monthly', byDay: [{ day: 'tu', nthOfPeriod: 2 } as never] } })
    const got = expand(monthly, ms('2026-04-01T00:00:00Z'), ms('2026-07-01T00:00:00Z'))
    assert.deepEqual(got.map((e) => e.start), ['2026-04-14T09:30:00', '2026-05-12T09:30:00', '2026-06-09T09:30:00'])
  })

  it('shows a moved occurrence where it was moved to, and leaves a deleted one out', () => {
    const daily = base({
      recurrenceRule: { frequency: 'daily', count: 5 },
      recurrenceOverrides: {
        '2026-03-03T09:00:00': { start: '2026-03-03T15:00:00', title: 'Standup (late)' },
        '2026-03-04T09:00:00': { excluded: true },
      },
    })
    const got = expand(daily, ms('2026-03-01T00:00:00Z'), ms('2026-03-10T00:00:00Z'))
    assert.deepEqual(got.map((e) => e.start), ['2026-03-02T09:00:00', '2026-03-03T15:00:00', '2026-03-05T09:00:00', '2026-03-06T09:00:00'])
    assert.equal(got[1]!.title, 'Standup (late)')
    assert.equal(got[1]!.recurrenceId, '2026-03-03T09:00:00')
  })

  it('finds an occurrence moved into the range from outside it', () => {
    const weekly = base({ recurrenceRule: { frequency: 'weekly', count: 3 }, recurrenceOverrides: { '2026-03-16T09:00:00': { start: '2026-03-04T09:00:00' } } })
    const got = expand(weekly, ms('2026-03-03T00:00:00Z'), ms('2026-03-05T00:00:00Z'))
    assert.deepEqual(got.map((e) => e.recurrenceId), ['2026-03-16T09:00:00'])
  })

  it('treats all-day events as whole days, without a zone', () => {
    const holiday = base({ start: '2026-12-24T00:00:00', duration: 'P2D', showWithoutTime: true, timeZone: null, recurrenceRule: { frequency: 'yearly' } })
    const got = expand(holiday, ms('2027-01-01T00:00:00Z'), ms('2028-01-01T00:00:00Z'))
    assert.deepEqual(starts(got), ['2027-12-24T00:00:00Z'])
    assert.equal(got[0]!.utcEnd, '2027-12-26T00:00:00Z')
  })

  it('returns a single event only when it overlaps the range', () => {
    const single = base({})
    assert.equal(expand(single, ms('2026-03-02T14:20:00Z'), ms('2026-03-02T15:00:00Z')).length, 1)
    assert.equal(expand(single, ms('2026-03-02T14:30:00Z'), ms('2026-03-02T15:00:00Z')).length, 0)
  })

  it('stops at the end of a series ending on a date', () => {
    const weekly = base({ recurrenceRule: { frequency: 'weekly', until: '2026-03-16T23:59:59' } })
    assert.equal(expand(weekly, ms('2026-03-01T00:00:00Z'), ms('2026-06-01T00:00:00Z')).length, 3)
  })
})

describe('timeColumns', () => {
  it('spans a series from its first start to the end of its last occurrence', () => {
    const counted = base({ recurrenceRule: { frequency: 'daily', count: 3 } })
    assert.deepEqual(timeColumns(counted), { startUtc: '2026-03-02T14:00:00Z', endUtc: '2026-03-04T14:30:00Z', recurring: true })
  })

  it('leaves the end open for a series that never ends', () => {
    assert.equal(timeColumns(base({ recurrenceRule: { frequency: 'weekly' } })).endUtc, null)
  })

  it('widens the span for an occurrence moved past the last one', () => {
    const counted = base({ recurrenceRule: { frequency: 'daily', count: 2 }, recurrenceOverrides: { '2026-03-03T09:00:00': { start: '2026-03-10T09:00:00' } } })
    assert.equal(timeColumns(counted).endUtc, '2026-03-10T13:30:00Z')
  })

  it('uses the real times of a single event', () => {
    assert.deepEqual(timeColumns(base({})), { startUtc: '2026-03-02T14:00:00Z', endUtc: '2026-03-02T14:30:00Z', recurring: false })
  })
})

describe('toRrule', () => {
  it('writes every part a JSCalendar rule can have', () => {
    assert.equal(
      toRrule({ frequency: 'monthly', interval: 2, byDay: [{ day: 'mo', nthOfPeriod: -1 }], byMonth: ['3', '9'], bySetPosition: [1], firstDayOfWeek: 'su', until: '2027-01-01T23:59:59' } as never),
      'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1MO;BYMONTH=3,9;BYSETPOS=1;WKST=SU;UNTIL=20270101T235959',
    )
    assert.equal(toRrule({ frequency: 'daily', count: 4 }), 'FREQ=DAILY;COUNT=4')
    assert.equal(toRrule(null), null)
  })
})

describe('occurrence ids', () => {
  it('round-trips the series and original start', () => {
    const id = occurrenceId('01JABC', '2026-03-09T09:00')
    assert.equal(id, '01JABC.20260309T090000')
    assert.deepEqual(parseOccurrenceId(id), { seriesId: '01JABC', recurrenceId: '2026-03-09T09:00:00' })
    assert.equal(parseOccurrenceId('01JABC'), null)
  })
})

describe('applyPatch and changesSchedule', () => {
  it('sets, replaces and removes by path, leaving the original alone', () => {
    const event = { title: 'A', participants: { g1: { participationStatus: 'needs-action' } }, locations: { l: { name: 'X' } } }
    const next = applyPatch(event, { title: 'B', 'participants/g1/participationStatus': 'accepted', locations: null })
    assert.deepEqual(next, { title: 'B', participants: { g1: { participationStatus: 'accepted' } } })
    assert.equal(event.title, 'A')
  })

  it('counts a change of time but not a guest\'s own answer', () => {
    assert.equal(changesSchedule({ start: '2026-03-02T10:00:00' }), true)
    assert.equal(changesSchedule({ 'participants/g1/participationStatus': 'accepted' }), false)
  })
})
