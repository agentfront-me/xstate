// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  durationMinutes,
  eventFields,
  ownParticipantKey,
  participants,
  rekeyOverrides,
  timeFields,
  toDuration,
  toEvent,
  zonedToUtc,
} from './calendar-events.ts'
import type { JmapEvent } from './stalwart/calendar.ts'

const me = ['priya@acme.test']

describe('durations', () => {
  it('round-trips minutes and ISO durations', () => {
    assert.equal(toDuration(60), 'PT1H')
    assert.equal(toDuration(90), 'PT1H30M')
    assert.equal(toDuration(1440), 'P1D')
    assert.equal(toDuration(0), 'PT0S')
    assert.equal(durationMinutes('P1DT2H5M'), 1565)
    assert.equal(durationMinutes('P1W'), 10080)
    assert.equal(durationMinutes('nonsense'), 0)
  })
})

describe('zonedToUtc', () => {
  it('converts local times in a zone to UTC, summer and winter', () => {
    assert.equal(zonedToUtc('2026-11-10T10:00', 'Asia/Karachi'), '2026-11-10T05:00:00Z')
    assert.equal(zonedToUtc('2026-11-10T10:00:00', 'Europe/London'), '2026-11-10T10:00:00Z')
    assert.equal(zonedToUtc('2026-07-01T10:00', 'Europe/London'), '2026-07-01T09:00:00Z')
    assert.equal(zonedToUtc('2026-07-01T09:00', 'America/New_York'), '2026-07-01T13:00:00Z')
    assert.equal(zonedToUtc('2026-11-11T15:00:00', 'Etc/UTC'), '2026-11-11T15:00:00Z')
  })
  it('takes an unknown zone as UTC', () => {
    assert.equal(zonedToUtc('2026-11-10T10:00', 'Mars/Olympus'), '2026-11-10T10:00:00Z')
  })
  it('gives parsed invites (no utcStart) correct UTC times', () => {
    const e = toEvent({ id: '', calendarIds: {}, start: '2026-11-10T10:00:00', duration: 'PT1H', timeZone: 'Asia/Karachi' }, [])
    assert.equal(e.start, '2026-11-10T05:00:00Z')
    assert.equal(e.end, '2026-11-10T06:00:00Z')
  })
})

describe('timeFields', () => {
  it('writes timed events as local start, duration and zone', () => {
    assert.deepEqual(timeFields({ allDay: false, start: '2026-11-10T10:00', end: '2026-11-10T11:30', timeZone: 'Europe/London' }), {
      start: '2026-11-10T10:00:00',
      duration: 'PT1H30M',
      timeZone: 'Europe/London',
      showWithoutTime: false,
    })
  })
  it('writes all-day events with an inclusive last day', () => {
    assert.deepEqual(timeFields({ allDay: true, start: '2026-11-13', end: '2026-11-14' }), {
      start: '2026-11-13T00:00:00',
      duration: 'P2D',
      showWithoutTime: true,
      timeZone: null,
    })
  })
  it('refuses an end before the start and a timed event without a zone', () => {
    assert.throws(() => timeFields({ allDay: false, start: '2026-11-10T11:00', end: '2026-11-10T10:00', timeZone: 'UTC' }), /ends before/)
    assert.throws(() => timeFields({ allDay: false, start: '2026-11-10T10:00', end: '2026-11-10T11:00' }), /timeZone/)
  })
})

describe('eventFields', () => {
  it('uses the JSCalendar 2.0 singular recurrenceRule', () => {
    const f = eventFields({
      title: 'Gym',
      allDay: false,
      start: '2026-11-09T18:00',
      end: '2026-11-09T19:00',
      timeZone: 'Europe/London',
      repeat: { frequency: 'weekly', days: ['mo', 'we'], until: '2026-12-31' },
    })
    assert.equal('recurrenceRules' in f, false)
    assert.deepEqual(f.recurrenceRule, {
      '@type': 'RecurrenceRule',
      frequency: 'weekly',
      byDay: [{ '@type': 'NDay', day: 'mo' }, { '@type': 'NDay', day: 'we' }],
      until: '2026-12-31T23:59:59',
    })
    assert.equal('locations' in f, false, 'left out means unchanged')
    assert.equal('description' in f, false)
    assert.equal(eventFields({ title: 'x', allDay: true, start: '2026-11-13', end: '2026-11-13', location: '', repeat: null }).locations, null)
  })
})

describe('rekeyOverrides', () => {
  it('moves occurrence keys with the series start, keeping their contents', () => {
    const moved = rekeyOverrides(
      { '2026-11-17T10:00:00': { title: 'Room 5' }, '2026-11-24T10:00:00': { excluded: true } },
      '2026-11-10T10:00:00',
      '2026-11-10T11:00:00',
    )
    assert.deepEqual(moved, { '2026-11-17T11:00:00': { title: 'Room 5' }, '2026-11-24T11:00:00': { excluded: true } })
  })
  it('moves across days too, and leaves an unchanged start alone', () => {
    const o = { '2026-11-17T10:00:00': { excluded: true } }
    assert.deepEqual(Object.keys(rekeyOverrides(o, '2026-11-10T10:00:00', '2026-11-11T09:30:00')), ['2026-11-18T09:30:00'])
    assert.equal(rekeyOverrides(o, '2026-11-10T10:00:00', '2026-11-10T10:00'), o)
  })
})

describe('participants', () => {
  const organizer = { email: 'priya@acme.test', name: 'Priya' }

  it('is null without guests, and drops the organizer from the guest list', () => {
    assert.equal(participants(organizer, [], null), null)
    assert.equal(participants(organizer, [{ email: 'Priya@acme.test' }], null), null)
  })

  it('names the organizer explicitly and keeps existing answers', () => {
    const existing: JmapEvent['participants'] = {
      o: { calendarAddress: 'mailto:priya@acme.test', roles: { owner: true, attendee: true } },
      m: { calendarAddress: 'mailto:marcus@acme.test', participationStatus: 'accepted', roles: { attendee: true } },
    }
    const out = participants(organizer, [{ email: 'marcus@acme.test' }, { email: 'NEW@example.com', optional: true }], existing)!
    assert.deepEqual(out.o!.roles, { owner: true, attendee: true })
    assert.equal(out.o!.calendarAddress, 'mailto:priya@acme.test')
    assert.equal(out.m!.participationStatus, 'accepted')
    const added = Object.values(out).find((p) => p.calendarAddress === 'mailto:new@example.com')!
    assert.equal(added.participationStatus, 'needs-action')
    assert.deepEqual(added.roles, { attendee: true, optional: true })
  })
})

describe('toEvent', () => {
  const base: JmapEvent = {
    id: 'd',
    calendarIds: { b: true },
    title: 'Pricing review',
    description: 'Q1 wholesale tiers.',
    start: '2026-11-10T10:00:00',
    duration: 'PT1H',
    timeZone: 'Europe/London',
    locations: { l: { name: 'Room 2' } },
    utcStart: '2026-11-10T10:00:00Z',
    utcEnd: '2026-11-10T11:00:00Z',
    organizerCalendarAddress: 'mailto:priya@acme.test',
    participants: {
      g1: { calendarAddress: 'mailto:marcus@acme.test', participationStatus: 'needs-action', roles: { attendee: true } },
      o: { calendarAddress: 'mailto:priya@acme.test', participationStatus: 'accepted', roles: { owner: true, attendee: true } },
    },
  }

  it('flattens a timed event for the organizer', () => {
    const e = toEvent(base, me)
    assert.equal(e.start, '2026-11-10T10:00:00Z')
    assert.equal(e.end, '2026-11-10T11:00:00Z')
    assert.equal(e.localStart, '2026-11-10T10:00')
    assert.equal(e.localEnd, '2026-11-10T11:00')
    assert.equal(e.location, 'Room 2')
    assert.equal(e.calendarId, 'b')
    assert.equal(e.status, 'confirmed')
    assert.equal(toEvent({ ...base, status: 'cancelled' }, me).status, 'cancelled')
    assert.equal(e.isOrganizer, true)
    assert.equal(e.myStatus, null)
    assert.equal(e.guests[0]!.organizer, true, 'organizer first')
  })

  it('shows a guest their own answer', () => {
    const e = toEvent(base, ['marcus@acme.test'])
    assert.equal(e.isOrganizer, false)
    assert.equal(e.myStatus, 'needs-action')
  })

  it('gives all-day events dates with an exclusive end and an inclusive localEnd', () => {
    const e = toEvent({ id: 'c', calendarIds: { b: true }, start: '2026-11-13T00:00:00', duration: 'P1D', showWithoutTime: true }, me)
    assert.equal(e.allDay, true)
    assert.equal(e.start, '2026-11-13')
    assert.equal(e.end, '2026-11-14')
    assert.equal(e.localEnd, '2026-11-13')
    assert.equal(e.timeZone, null)
    assert.equal(e.isOrganizer, true, 'no guests means it is yours')
  })

  it('marks occurrences of a repeating event', () => {
    const e = toEvent(
      {
        id: 'h1qtleaaaaab',
        baseEventId: 'b',
        recurrenceId: '2026-11-09T18:00:00',
        calendarIds: { c: true },
        start: '2026-11-09T18:00:00',
        duration: 'PT1H',
        timeZone: 'Europe/London',
        recurrenceRule: { frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'we' }] },
      },
      me,
    )
    assert.equal(e.seriesId, 'b')
    assert.equal(e.occurrence, '2026-11-09T18:00')
    assert.deepEqual(e.repeat, { frequency: 'weekly', interval: 1, days: ['mo', 'we'], until: null, count: null })
  })

  it('treats an organizer-only list as no guests', () => {
    const e = toEvent({ ...base, participants: { o: base.participants!.o! } }, me)
    assert.deepEqual(e.guests, [])
    assert.equal(e.isOrganizer, true)
  })

  it('finds its own participant key for RSVP', () => {
    assert.equal(ownParticipantKey(base.participants, ['marcus@acme.test']), 'g1')
    assert.equal(ownParticipantKey(base.participants, ['nobody@acme.test']), null)
  })
})
