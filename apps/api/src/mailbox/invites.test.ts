// pnpm --filter @xstate/api test
// Phase 3b: invitation files, the emails around them, and who gets what.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import ICAL from 'ical.js'
import PostalMime from 'postal-mime'
import { zonedToUtc } from '../mailserver/calendar-events.ts'
import type { JmapEvent } from '../mailserver/stalwart/calendar'
import { buildMessage } from './compose.ts'
import { buildIcs } from './ical-out.ts'
import { inviteText, whenText } from './invite-mail.ts'
import { scheduling } from './scheduling.ts'

const NOW = new Date('2026-11-18T10:00:00Z')
const ORG = 'hello@99events.com'
const people = (statuses: Record<string, string> = {}) => ({
  o: { name: 'Hello Team', calendarAddress: `mailto:${ORG}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
  g1: { name: 'Sam', calendarAddress: 'mailto:sam@gmail.com', roles: { attendee: true }, participationStatus: statuses.sam ?? 'needs-action' },
  g2: { calendarAddress: 'mailto:kim@outlook.com', roles: { attendee: true, optional: true }, participationStatus: statuses.kim ?? 'needs-action' },
})
const event = (over: Partial<JmapEvent> = {}): JmapEvent => ({
  id: 'E1',
  uid: 'uid-1',
  sequence: 1,
  calendarIds: { c: true },
  title: 'Planning, Q1; draft',
  description: 'Agenda:\n1. Budget',
  start: '2026-03-02T09:00:00',
  duration: 'PT45M',
  timeZone: 'America/New_York',
  locations: { l: { name: 'Room 4' } },
  participants: people(),
  ...over,
})

/** The VEVENTs of an iCalendar text, parsed back with ical.js. */
function parse(ics: string) {
  const cal = new ICAL.Component(ICAL.parse(ics))
  ICAL.TimezoneService.reset()
  for (const tz of cal.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz)
  return { cal, events: cal.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v)) }
}

describe('buildIcs', () => {
  it('writes a request that parses back to the same event', () => {
    const ics = buildIcs({ method: 'REQUEST', event: event(), now: NOW })
    assert.match(ics, /\r\n/)
    const { cal, events } = parse(ics)
    assert.equal(cal.getFirstPropertyValue('method'), 'REQUEST')
    const e = events[0]!
    assert.equal(e.uid, 'uid-1')
    assert.equal(e.sequence, 1)
    assert.equal(e.summary, 'Planning, Q1; draft')
    assert.equal(e.description, 'Agenda:\n1. Budget')
    assert.equal(e.location, 'Room 4')
    assert.equal(e.startDate.toJSDate().toISOString(), '2026-03-02T14:00:00.000Z')
    assert.equal(e.endDate.toJSDate().toISOString(), '2026-03-02T14:45:00.000Z')
    assert.equal(e.organizer, `mailto:${ORG}`)
    const sam = e.attendees.find((a) => a.getFirstValue() === 'mailto:sam@gmail.com')!
    assert.equal(sam.getParameter('partstat'), 'NEEDS-ACTION')
    assert.equal(sam.getParameter('rsvp'), 'TRUE')
    assert.equal(e.attendees.find((a) => a.getFirstValue() === 'mailto:kim@outlook.com')!.getParameter('role'), 'OPT-PARTICIPANT')
  })

  it('gives every occurrence of a series the UTC time zonedToUtc gives, across daylight saving', () => {
    for (const zone of ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Karachi']) {
      const series = event({ timeZone: zone, start: '2026-01-05T09:00:00', recurrenceRule: { frequency: 'weekly', count: 52 } })
      const { events } = parse(buildIcs({ method: 'REQUEST', event: series, now: NOW }))
      const it = events[0]!.iterator()
      for (let n = it.next(); n; n = it.next()) {
        const local = n.toString().slice(0, 19)
        const parsed = events[0]!.getOccurrenceDetails(n).startDate.toJSDate().toISOString().slice(0, 19) + 'Z'
        assert.equal(parsed, zonedToUtc(local, zone), `${zone} ${local}`)
      }
    }
  })

  it('writes a series with a deleted occurrence as EXDATE and a moved one as its own VEVENT', () => {
    const series = event({
      recurrenceRule: { frequency: 'weekly', until: '2026-03-30T23:59:59' },
      recurrenceOverrides: { '2026-03-16T09:00:00': { start: '2026-03-17T11:00:00', title: 'Moved' }, '2026-03-23T09:00:00': { excluded: true } },
    })
    const ics = buildIcs({ method: 'REQUEST', event: series, now: NOW })
    assert.match(ics, /RRULE:FREQ=WEEKLY;UNTIL=20260331T035959Z/)
    assert.match(ics, /EXDATE;TZID=America\/New_York:20260323T090000/)
    const { events } = parse(ics)
    assert.equal(events.length, 2)
    const moved = events[1]!
    assert.equal(moved.recurrenceId.toString(), '2026-03-16T09:00:00')
    assert.equal(moved.summary, 'Moved')
    assert.equal(moved.startDate.toJSDate().toISOString(), '2026-03-17T15:00:00.000Z')
  })

  it('writes all-day events as dates', () => {
    const ics = buildIcs({ method: 'REQUEST', event: event({ start: '2026-12-24T00:00:00', duration: 'P2D', showWithoutTime: true, timeZone: null }), now: NOW })
    assert.match(ics, /DTSTART;VALUE=DATE:20261224/)
    assert.match(ics, /DTEND;VALUE=DATE:20261226/)
    assert.doesNotMatch(ics, /VTIMEZONE/)
  })

  it('cancels one occurrence with its RECURRENCE-ID', () => {
    const series = event({ recurrenceRule: { frequency: 'weekly', count: 4 } })
    const { cal, events } = parse(buildIcs({ method: 'CANCEL', event: series, occurrence: '2026-03-09T09:00', now: NOW }))
    assert.equal(cal.getFirstPropertyValue('method'), 'CANCEL')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.recurrenceId.toString(), '2026-03-09T09:00:00')
    assert.equal(events[0]!.component.getFirstPropertyValue('status'), 'CANCELLED')
    assert.equal(events[0]!.component.getFirstPropertyValue('rrule'), null)
  })

  it('answers with only the replying attendee', () => {
    const invited = event({ participants: people({ sam: 'accepted' }) })
    const { cal, events } = parse(buildIcs({ method: 'REPLY', event: invited, replyFrom: 'sam@gmail.com', now: NOW }))
    assert.equal(cal.getFirstPropertyValue('method'), 'REPLY')
    assert.equal(events[0]!.attendees.length, 1)
    assert.equal(events[0]!.attendees[0]!.getParameter('partstat'), 'ACCEPTED')
    assert.equal(events[0]!.attendees[0]!.getParameter('rsvp'), undefined)
  })

  it('gives a zone without daylight saving a single STANDARD block', () => {
    const ics = buildIcs({ method: 'REQUEST', event: event({ timeZone: 'Asia/Karachi' }), now: NOW })
    assert.equal(ics.match(/BEGIN:STANDARD/g)?.length, 1)
    assert.doesNotMatch(ics, /BEGIN:DAYLIGHT/)
    assert.match(ics, /TZOFFSETTO:\+0500/)
  })
})

describe('scheduling', () => {
  const own = [ORG]
  const organized = event()

  it('invites every guest of a new event', () => {
    assert.deepEqual(scheduling(null, organized, own).map((e) => [e.kind, e.to]), [['invitation', ['sam@gmail.com', 'kim@outlook.com']]])
  })

  it('updates guests when the time changes, but not when only an answer changes', () => {
    const moved = { ...organized, start: '2026-03-02T10:00:00', sequence: 2 }
    assert.deepEqual(scheduling(organized, moved, own).map((e) => e.kind), ['update'])
    const answered = { ...organized, participants: people({ sam: 'accepted' }) }
    assert.deepEqual(scheduling(organized, answered, own), [])
  })

  it('cancels for a removed guest, invites an added one, and tells the others the guest list changed', () => {
    const p = people()
    const changed = { ...organized, sequence: 2, participants: { o: p.o, g1: p.g1, g3: { calendarAddress: 'mailto:new@example.org', roles: { attendee: true } } } }
    assert.deepEqual(scheduling(organized, changed, own).map((e) => [e.kind, e.to]), [
      ['cancel', ['kim@outlook.com']],
      ['invitation', ['new@example.org']],
      ['update', ['sam@gmail.com']],
    ])
  })

  it('cancels a deleted occurrence on its own, and the whole event when it is deleted', () => {
    const series = { ...organized, recurrenceRule: { frequency: 'weekly' } }
    const oneGone = { ...series, sequence: 2, recurrenceOverrides: { '2026-03-09T09:00:00': { excluded: true } } }
    assert.deepEqual(scheduling(series, oneGone, own).map((e) => [e.kind, e.occurrence ?? null]), [['cancel', '2026-03-09T09:00:00']])
    assert.deepEqual(scheduling(series, null, own).map((e) => [e.kind, e.to.length]), [['cancel', 2]])
  })

  it('has a guest answer the organizer only when their answer changes', () => {
    const invited = { ...organized }
    const accepted = { ...organized, participants: people({ sam: 'accepted' }) }
    assert.deepEqual(scheduling(invited, accepted, ['sam@gmail.com']).map((e) => [e.kind, e.to]), [['accepted', [ORG]]])
    assert.deepEqual(scheduling(accepted, accepted, ['sam@gmail.com']), [])
    assert.deepEqual(scheduling(null, accepted, ['sam@gmail.com']).map((e) => e.kind), ['accepted'])
    assert.deepEqual(scheduling(accepted, null, ['sam@gmail.com']), [])
  })

  it('sends nothing for an event without guests', () => {
    assert.deepEqual(scheduling(null, event({ participants: null }), own), [])
  })
})

describe('invitation emails', () => {
  it('names the change, the event and its time in the subject', () => {
    assert.equal(inviteText('invitation', event()).subject, 'Invitation: Planning, Q1; draft @ Mon 2 Mar 2026 9am – 9:45am (GMT-5)')
    assert.match(inviteText('declined', event(), { who: { name: 'Sam', email: 'sam@gmail.com' } }).text, /^Sam <sam@gmail.com> declined this invitation\./)
    assert.equal(whenText(event({ start: '2026-12-24T00:00:00', duration: 'P1D', showWithoutTime: true, timeZone: null })), 'Thu 24 Dec 2026')
  })

  it('escapes the HTML', () => {
    assert.match(inviteText('invitation', event({ title: '<b>x</b> & y' })).html, /&lt;b&gt;x&lt;\/b&gt; &amp; y/)
  })

  it('carries the invitation as text/calendar inside the alternative and as invite.ics', async () => {
    const ics = buildIcs({ method: 'REQUEST', event: event(), now: NOW })
    const raw = buildMessage({ from: { name: 'Hello Team', email: ORG }, to: [{ name: 'Sam', email: 'sam@gmail.com' }], subject: 'Invitation', text: 'x', html: '<p>x</p>', messageId: 'm@99events.com', date: NOW, calendar: { method: 'REQUEST', ics } })
    const source = new TextDecoder().decode(raw)
    assert.match(source, /multipart\/mixed[\s\S]*multipart\/alternative[\s\S]*text\/plain[\s\S]*text\/html[\s\S]*text\/calendar; charset="utf-8"; method=REQUEST/)
    const parsed = await PostalMime.parse(raw)
    const file = parsed.attachments.find((a) => a.filename === 'invite.ics')!
    assert.equal(file.mimeType, 'application/ics')
    const content = typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content as ArrayBuffer)
    assert.equal(content.replace(/\r\n/g, '\n'), ics.replace(/\r\n/g, '\n'))
    // The calendar part itself is base64 of the CRLF text, so nothing on the way rewraps its folded lines.
    assert.match(source, /text\/calendar[^\r]*\r\nContent-Transfer-Encoding: base64/)
  })
})
