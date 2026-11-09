// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { convertEvent, exdateKeys, MAX_PARTICIPANTS, occurrenceOverride, parseRrule, skipReason, utcToZoned } from './calendar-rules.ts'
import type { GEvent } from './google/workspace.ts'

const ctx = { timeZone: 'America/New_York', googleAddresses: ['ana@acme.com'], address: 'ana@acme.com' }
const ny = (local: string) => ({ dateTime: local, timeZone: 'America/New_York' })

describe('utcToZoned', () => {
  it('turns an instant into wall-clock time in a zone, across DST', () => {
    assert.equal(utcToZoned('2026-11-10T14:00:00Z', 'America/New_York'), '2026-11-10T09:00:00')
    assert.equal(utcToZoned('2026-07-10T13:00:00Z', 'America/New_York'), '2026-07-10T09:00:00')
    assert.equal(utcToZoned('2026-11-10T09:00:00-05:00', 'Europe/London'), '2026-11-10T14:00:00')
    assert.equal(utcToZoned('2026-11-10T09:00:00Z', 'Not/AZone'), '2026-11-10T09:00:00')
  })
})

describe('parseRrule', () => {
  it('reads the common Google rules', () => {
    assert.deepEqual(parseRrule('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=40'), {
      '@type': 'RecurrenceRule',
      frequency: 'weekly',
      count: 40,
      byDay: ['mo', 'tu', 'we', 'th', 'fr'].map((day) => ({ '@type': 'NDay', day })),
    })
    assert.deepEqual(parseRrule('RRULE:FREQ=MONTHLY;BYDAY=-1FR'), {
      '@type': 'RecurrenceRule',
      frequency: 'monthly',
      byDay: [{ '@type': 'NDay', day: 'fr', nthOfPeriod: -1 }],
    })
    assert.deepEqual(parseRrule('RRULE:FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=15;INTERVAL=2;WKST=SU'), {
      '@type': 'RecurrenceRule',
      frequency: 'yearly',
      interval: 2,
      byMonthDay: [15],
      byMonth: ['11'],
      firstDayOfWeek: 'su',
    })
    assert.equal((parseRrule('RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1') as { bySetPosition: number[] }).bySetPosition[0], -1)
  })
  it('turns UNTIL into a local date-time and ignores nonsense', () => {
    assert.equal(parseRrule('RRULE:FREQ=DAILY;UNTIL=20261231T045959Z')!.until, '2026-12-31T04:59:59')
    assert.equal(parseRrule('RRULE:FREQ=DAILY;UNTIL=20261231')!.until, '2026-12-31T23:59:59')
    assert.equal(parseRrule('RRULE:FREQ=FORTNIGHTLY'), null)
  })
})

describe('exdateKeys', () => {
  it('reads the zone-, UTC- and date-forms as local keys in the series zone', () => {
    assert.deepEqual(exdateKeys('EXDATE;TZID=America/New_York:20261111T090000', 'America/New_York', false), ['2026-11-11T09:00:00'])
    assert.deepEqual(exdateKeys('EXDATE:20261111T140000Z,20261112T140000Z', 'America/New_York', false), ['2026-11-11T09:00:00', '2026-11-12T09:00:00'])
    assert.deepEqual(exdateKeys('EXDATE;TZID=Europe/London:20261111T140000', 'America/New_York', false), ['2026-11-11T09:00:00'])
    assert.deepEqual(exdateKeys('EXDATE;VALUE=DATE:20261225', 'America/New_York', true), ['2026-12-25T00:00:00'])
  })
})

describe('convertEvent', () => {
  it('copies a timed series in its own zone, with repeat rule and excluded dates', () => {
    const e: GEvent = {
      id: 's',
      summary: 'Standup',
      start: ny('2026-11-09T14:00:00Z'),
      end: ny('2026-11-09T14:15:00Z'),
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4', 'EXDATE;TZID=America/New_York:20261116T090000'],
      iCalUID: 'standup@google.com',
      organizer: { email: 'ana@acme.com', self: true },
    }
    const { fields, trimmed } = convertEvent(e, ctx)
    assert.equal(trimmed, 0)
    assert.equal(fields.uid, 'standup@google.com')
    assert.equal(fields.start, '2026-11-09T09:00:00')
    assert.equal(fields.timeZone, 'America/New_York')
    assert.equal(fields.duration, 'PT15M')
    assert.deepEqual(fields.recurrenceOverrides, { '2026-11-16T09:00:00': { excluded: true } })
    assert.equal('participants' in fields, false, 'own event without guests has no guest list')
  })

  it('copies all-day events with an exclusive end', () => {
    const { fields } = convertEvent({ id: 'd', summary: 'Off', start: { date: '2026-11-20' }, end: { date: '2026-11-22' }, transparency: 'transparent' }, ctx)
    assert.equal(fields.start, '2026-11-20T00:00:00')
    assert.equal(fields.duration, 'P2D')
    assert.equal(fields.showWithoutTime, true)
    assert.equal(fields.freeBusyStatus, 'free')
  })

  it("keeps someone else's meeting as theirs, with the person's own answer", () => {
    const { fields } = convertEvent(
      {
        id: 'c',
        start: ny('2026-11-11T20:00:00Z'),
        end: ny('2026-11-11T20:30:00Z'),
        organizer: { email: 'maria@example.org' },
        attendees: [
          { email: 'maria@example.org', organizer: true, responseStatus: 'accepted' },
          { email: 'ana@acme.com', self: true, responseStatus: 'needsAction' },
          { email: 'room@resource.calendar.google.com', resource: true },
        ],
      },
      ctx,
    )
    assert.equal(fields.organizerCalendarAddress, 'mailto:maria@example.org')
    const people = Object.values(fields.participants as Record<string, { calendarAddress: string; roles: object; participationStatus: string }>)
    assert.equal(people.length, 2, 'rooms are left out')
    assert.deepEqual(people.find((p) => p.calendarAddress === 'mailto:maria@example.org')!.roles, { attendee: true, owner: true })
    assert.equal(people.find((p) => p.calendarAddress === 'mailto:ana@acme.com')!.participationStatus, 'needs-action')
  })

  it('maps the Google address to the xstate one when they differ', () => {
    const { fields } = convertEvent(
      { id: 'x', start: ny('2026-11-11T20:00:00Z'), end: ny('2026-11-11T21:00:00Z'), organizer: { email: 'ana@old.com', self: true }, attendees: [{ email: 'ana@old.com', self: true }, { email: 'bo@acme.com' }] },
      { ...ctx, googleAddresses: ['ana@old.com'] },
    )
    assert.equal(fields.organizerCalendarAddress, 'mailto:ana@acme.com')
  })

  it('keeps the organizer and the person when trimming a big meeting', () => {
    const attendees = Array.from({ length: 30 }, (_, i) => ({ email: `p${i}@acme.com` }))
    const { fields, trimmed } = convertEvent(
      { id: 'big', summary: 'All hands', start: ny('2026-11-13T21:00:00Z'), end: ny('2026-11-13T22:00:00Z'), organizer: { email: 'ceo@acme.com' }, attendees: [...attendees, { email: 'ana@acme.com', self: true }] },
      ctx,
    )
    const people = Object.values(fields.participants as Record<string, { calendarAddress: string }>).map((p) => p.calendarAddress)
    assert.equal(people.length, MAX_PARTICIPANTS)
    assert.ok(people.includes('mailto:ceo@acme.com') && people.includes('mailto:ana@acme.com'))
    assert.equal(trimmed, 32 - MAX_PARTICIPANTS)
    assert.match(fields.description as string, /12 more guests weren't copied/)
  })
})

describe('occurrenceOverride and skipReason', () => {
  it('keys a moved occurrence by its original start, keeping only real changes', () => {
    const o = occurrenceOverride(
      { id: 'x', recurringEventId: 's', originalStartTime: ny('2026-11-10T14:00:00Z'), summary: 'Moved', start: ny('2026-11-10T15:00:00Z'), end: ny('2026-11-10T15:15:00Z') },
      'America/New_York',
      'PT15M',
    )!
    assert.equal(o.key, '2026-11-10T09:00:00')
    assert.deepEqual(o.value, { title: 'Moved', start: '2026-11-10T10:00:00' })
  })
  it('turns a cancelled occurrence into an exclusion', () => {
    assert.deepEqual(occurrenceOverride({ id: 'x', status: 'cancelled', recurringEventId: 's', originalStartTime: { date: '2026-12-25' } }, null, 'P1D'), {
      key: '2026-12-25T00:00:00',
      value: { excluded: true },
    })
  })
  it('skips cancelled, working-location and birthday entries', () => {
    assert.equal(skipReason({ id: 'a', status: 'cancelled' }), 'cancelled')
    assert.equal(skipReason({ id: 'b', eventType: 'workingLocation', start: { date: '2026-11-10' }, end: { date: '2026-11-11' } }), 'working_location')
    assert.equal(skipReason({ id: 'c', start: { date: '2026-11-10' }, end: { date: '2026-11-11' } }), null)
  })
})
