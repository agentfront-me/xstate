// pnpm --filter @xstate/api test
// Phase 3c: reading invitation files, proving who sent them, and deciding what they do to the calendar.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { zonedToUtc } from '../mailserver/calendar-events.ts'
import type { StoredEvent } from '../mailserver/calendar-types'
import { decide, timeMoved, type IncomingContext } from './calendar-in.ts'
import { buildIcs } from './ical-out.ts'
import { parseIcs } from './ical-in.ts'
import { headerLines, proveSender } from './sender-auth.ts'

const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n'

// Google Calendar's answer, as received on the pilot (names and address changed).
const GOOGLE_REPLY = crlf([
  'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:REPLY',
  'BEGIN:VTIMEZONE', 'TZID:Asia/Karachi', 'X-LIC-LOCATION:Asia/Karachi', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0500', 'TZOFFSETTO:+0500', 'TZNAME:GMT+5', 'DTSTART:19700101T000000', 'END:STANDARD', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'DTSTART;TZID=Asia/Karachi:20261124T150000', 'DTEND;TZID=Asia/Karachi:20261124T153000', 'RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=TU', 'DTSTAMP:20261118T070035Z',
  'ORGANIZER;CN=99events:mailto:hello@99events.com', 'UID:79091693-d294-4e61-9ba0-606a2e77b1ab',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Sam Lee;X-NUM-GUESTS=0:mailto:sam.lee@gmail.com',
  'CREATED:20261118T065937Z', 'DESCRIPTION:Testing answers.', 'LAST-MODIFIED:20261118T070034Z', 'LOCATION:', 'SEQUENCE:0', 'STATUS:CONFIRMED', 'SUMMARY:xstate answer test', 'TRANSP:OPAQUE',
  'END:VEVENT', 'END:VCALENDAR',
])

// Outlook: a Windows zone name, a deleted occurrence, and a moved one.
const OUTLOOK_REQUEST = crlf([
  'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'PRODID:Microsoft Exchange Server 2010', 'VERSION:2.0',
  'BEGIN:VTIMEZONE', 'TZID:Pakistan Standard Time', 'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0500', 'TZOFFSETTO:+0500', 'END:STANDARD', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'ORGANIZER;CN=Kim Park:mailto:kim@contoso.com',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=hello@99events.com:mailto:hello@99events.com',
  'RRULE:FREQ=WEEKLY;UNTIL=20261215T100000Z;INTERVAL=1;BYDAY=TU;WKST=SU',
  'EXDATE;TZID=Pakistan Standard Time:20261208T150000',
  'UID:040000008200E00074C5B7101A82E0080000000', 'SUMMARY;LANGUAGE=en-US:Weekly sync', 'DTSTART;TZID=Pakistan Standard Time:20261124T150000', 'DTEND;TZID=Pakistan Standard Time:20261124T160000',
  'CLASS:PUBLIC', 'PRIORITY:5', 'DTSTAMP:20261118T080000Z', 'TRANSP:OPAQUE', 'STATUS:CONFIRMED', 'SEQUENCE:0', 'LOCATION;LANGUAGE=en-US:Microsoft Teams Meeting',
  'END:VEVENT',
  'BEGIN:VEVENT', 'ORGANIZER;CN=Kim Park:mailto:kim@contoso.com', 'UID:040000008200E00074C5B7101A82E0080000000',
  'RECURRENCE-ID;TZID=Pakistan Standard Time:20261201T150000', 'SUMMARY;LANGUAGE=en-US:Weekly sync (moved)',
  'DTSTART;TZID=Pakistan Standard Time:20261202T110000', 'DTEND;TZID=Pakistan Standard Time:20261202T120000', 'SEQUENCE:0', 'DTSTAMP:20261118T080000Z',
  'END:VEVENT', 'END:VCALENDAR',
])

// Outlook's own zone id (no IANA or Windows name): matched by the offsets in its VTIMEZONE.
const OUTLOOK_CUSTOM_ZONE = crlf([
  'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'VERSION:2.0',
  'BEGIN:VTIMEZONE', 'TZID:(UTC-05:00) Eastern Time (US & Canada)',
  'BEGIN:STANDARD', 'DTSTART:16011104T020000', 'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010311T020000', 'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:custom-zone-1', 'ORGANIZER:mailto:kim@contoso.com', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:hello@99events.com',
  'DTSTART;TZID="(UTC-05:00) Eastern Time (US & Canada)":20260702T090000', 'DTEND;TZID="(UTC-05:00) Eastern Time (US & Canada)":20260702T093000', 'SUMMARY:Summer call', 'SEQUENCE:1',
  'END:VEVENT', 'END:VCALENDAR',
])

// Apple Calendar: an all-day event over two days.
const APPLE_REQUEST = crlf([
  'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'PRODID:-//Apple Inc.//macOS 15.1//EN', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:A1B2C3D4-apple', 'DTSTART;VALUE=DATE:20261224', 'DTEND;VALUE=DATE:20261226', 'SUMMARY:Holidays',
  'ORGANIZER;CN="Ana":mailto:ana@icloud.com', 'ATTENDEE;CN="Ana";PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:ana@icloud.com',
  'ATTENDEE;PARTSTAT=NEEDS-ACTION;ROLE=OPT-PARTICIPANT;RSVP=TRUE:mailto:hello@99events.com', 'SEQUENCE:0', 'DTSTAMP:20261118T080000Z',
  'END:VEVENT', 'END:VCALENDAR',
])

describe('parseIcs', () => {
  it("reads Google's answer: the zone, the repeat rule and the guest's answer", () => {
    const f = parseIcs(GOOGLE_REPLY)!
    assert.equal(f.method, 'reply')
    assert.equal(f.event!.timeZone, 'Asia/Karachi')
    assert.equal(f.event!.start, '2026-11-24T15:00:00')
    assert.equal(f.event!.duration, 'PT30M')
    assert.deepEqual(f.event!.recurrenceRule, { '@type': 'RecurrenceRule', frequency: 'weekly', count: 2, byDay: [{ '@type': 'NDay', day: 'tu' }] })
    assert.equal(f.event!.participants!.a1!.participationStatus, 'accepted')
    assert.equal(f.event!.participants!.a1!.name, 'Sam Lee')
    assert.equal(f.event!.organizerCalendarAddress, 'mailto:hello@99events.com')
  })

  it("maps Outlook's Windows zone name, and keeps its deleted and moved occurrences", () => {
    const f = parseIcs(OUTLOOK_REQUEST)!
    const e = f.event!
    assert.equal(e.timeZone, 'Asia/Karachi')
    assert.equal(e.title, 'Weekly sync')
    assert.equal(e.locations!.l!.name, 'Microsoft Teams Meeting')
    assert.equal((e.recurrenceRule as Record<string, unknown>).until, '2026-12-15T15:00:00')
    assert.deepEqual(e.recurrenceOverrides!['2026-12-08T15:00:00'], { excluded: true })
    // The exception leaves out the location and guests: they stay the series'.
    assert.deepEqual(e.recurrenceOverrides!['2026-12-01T15:00:00'], { start: '2026-12-02T11:00:00', title: 'Weekly sync (moved)' })
    assert.equal(e.participants!.a1!.expectReply, true)
  })

  it("matches Outlook's own zone id by its offsets", () => {
    const e = parseIcs(OUTLOOK_CUSTOM_ZONE)!.event!
    assert.equal(e.timeZone, 'America/New_York')
    assert.equal(zonedToUtc(e.start, e.timeZone!), '2026-07-02T13:00:00Z')
  })

  it('reads an all-day event from Apple Calendar, with the organizer as the owner', () => {
    const e = parseIcs(APPLE_REQUEST)!.event!
    assert.equal(e.showWithoutTime, true)
    assert.equal(e.start, '2026-12-24T00:00:00')
    assert.equal(e.duration, 'P2D')
    assert.deepEqual(e.participants!.o!.roles, { owner: true, attendee: true })
    assert.equal(e.participants!.a1!.roles!.optional, true)
  })

  it('reads back what we send', () => {
    const ours = {
      id: 'E1', uid: 'u-1', sequence: 3, calendarIds: { c: true }, title: 'Standup', description: 'Notes, with; marks', start: '2026-03-02T09:00:00', duration: 'PT30M', timeZone: 'America/New_York',
      recurrenceRule: { frequency: 'weekly', until: '2026-04-30T23:59:59' },
      recurrenceOverrides: { '2026-03-16T09:00:00': { start: '2026-03-17T11:00:00', title: 'Moved' }, '2026-03-23T09:00:00': { excluded: true } },
      participants: { o: { calendarAddress: 'mailto:hello@99events.com', roles: { owner: true, attendee: true }, participationStatus: 'accepted' }, g: { calendarAddress: 'mailto:a@gmail.com', roles: { attendee: true }, participationStatus: 'needs-action' } },
    } as unknown as StoredEvent
    const back = parseIcs(buildIcs({ method: 'REQUEST', event: ours }))!.event!
    for (const field of ['uid', 'sequence', 'title', 'description', 'start', 'duration', 'timeZone'] as const) assert.deepEqual(back[field], ours[field], field)
    assert.equal((back.recurrenceRule as Record<string, unknown>).until, '2026-04-30T23:59:59')
    assert.deepEqual(back.recurrenceOverrides, ours.recurrenceOverrides)
  })

  it('reads a cancellation of one occurrence as that occurrence only', () => {
    const series = parseIcs(OUTLOOK_REQUEST)!.event!
    const f = parseIcs(buildIcs({ method: 'CANCEL', event: { ...series, id: 'x' } as StoredEvent, occurrence: '2026-11-24T15:00:00' }))!
    assert.equal(f.method, 'cancel')
    assert.equal(f.event, null)
    assert.deepEqual(Object.keys(f.occurrences), ['2026-11-24T15:00:00'])
  })

  it('returns null for something that is not a calendar', () => {
    assert.equal(parseIcs('hello'), null)
  })
})

describe('proveSender', () => {
  const headers = (...results: string[]) => headerLines(new TextEncoder().encode([...results.map((r) => `Authentication-Results: ${r}`), 'From: Sam <sam.lee@gmail.com>', '', 'body'].join('\r\n')))
  const ses = (rest: string) => `amazonses.com; spf=pass (spfCheck: ok) client-ip=1.2.3.4; envelope-from=x@y.com; helo=h; ${rest}`

  it('takes an aligned DMARC pass, or an aligned DKIM pass', () => {
    assert.deepEqual(proveSender(headers(ses('dkim=pass header.i=@google.com; dkim=pass header.i=@gmail.com; dmarc=pass header.from=gmail.com')), 'sam.lee@gmail.com'), { proven: true, how: 'dmarc', reason: null })
    assert.equal(proveSender(headers(ses('dkim=pass header.i=@gmail.com; dmarc=none header.from=gmail.com')), 'sam.lee@gmail.com').how, 'dkim')
    assert.equal(proveSender(headers(ses('dkim=pass header.i=@mail.contoso.com')), 'kim@contoso.com').how, 'dkim')
  })

  it("refuses SPF alone, another domain's signature, and a failed DMARC", () => {
    assert.equal(proveSender(headers(ses('dkim=none')), 'sam.lee@gmail.com').proven, false)
    assert.equal(proveSender(headers(ses('dkim=pass header.i=@evil.example')), 'sam.lee@gmail.com').proven, false)
    assert.equal(proveSender(headers(ses('dkim=fail header.i=@gmail.com; dmarc=fail header.from=gmail.com')), 'sam.lee@gmail.com').proven, false)
  })

  it("reads only SES's own header, the first one", () => {
    // A sender's forged "pass" below SES's real result changes nothing.
    assert.equal(proveSender(headers(ses('dmarc=fail header.from=gmail.com'), 'amazonses.com; dmarc=pass header.from=gmail.com'), 'sam.lee@gmail.com').proven, false)
    assert.equal(proveSender(headers('mx.example; dmarc=pass header.from=gmail.com'), 'sam.lee@gmail.com').reason, 'not_from_ses')
    assert.equal(proveSender(headers(), 'sam.lee@gmail.com').reason, 'no_authentication_results')
  })
})

describe('decide', () => {
  const HELLO = 'hello@99events.com'
  const ctx = (over: Partial<IncomingContext> = {}): IncomingContext => ({ from: 'sam.lee@gmail.com', proven: true, known: true, junk: false, own: [HELLO], ...over })
  const ours = (over: Partial<StoredEvent> = {}): StoredEvent =>
    ({
      id: 'E1', uid: '79091693-d294-4e61-9ba0-606a2e77b1ab', sequence: 0, calendarIds: { c: true }, title: 'xstate answer test', start: '2026-11-24T15:00:00', duration: 'PT30M', timeZone: 'Asia/Karachi',
      participants: { o: { calendarAddress: `mailto:${HELLO}`, roles: { owner: true, attendee: true } }, g: { calendarAddress: 'mailto:sam.lee@gmail.com', roles: { attendee: true }, participationStatus: 'needs-action' } },
      ...over,
    }) as StoredEvent
  const reply = parseIcs(GOOGLE_REPLY)!

  it("records a guest's answer to our event", () => {
    assert.deepEqual(decide(reply, ours(), ctx()), { action: 'answer', email: 'sam.lee@gmail.com', status: 'accepted', occurrences: [] })
  })

  it('refuses an answer from someone else, an unproven one, or one for an event we do not organize', () => {
    assert.deepEqual(decide(reply, ours(), ctx({ from: 'mallory@gmail.com' })), { action: 'skip', reason: 'not_from_guest' })
    assert.deepEqual(decide(reply, ours(), ctx({ proven: false })), { action: 'skip', reason: 'not_authenticated' })
    assert.deepEqual(decide(reply, null, ctx()), { action: 'skip', reason: 'unknown_event' })
    assert.deepEqual(decide(reply, ours({ organizerCalendarAddress: 'mailto:other@x.com', participants: null }), ctx()), { action: 'skip', reason: 'not_our_event' })
  })

  it('adds a new invitation from a known sender only', () => {
    const invite = parseIcs(OUTLOOK_REQUEST)!
    assert.deepEqual(decide(invite, null, ctx({ from: 'kim@contoso.com' })), { action: 'add' })
    assert.deepEqual(decide(invite, null, ctx({ from: 'kim@contoso.com', known: false })), { action: 'skip', reason: 'unknown_sender' })
    assert.deepEqual(decide(invite, null, ctx({ from: 'kim@contoso.com', own: ['someone@else.com'] })), { action: 'skip', reason: 'not_invited' })
    assert.deepEqual(decide(invite, null, ctx({ from: 'kim@contoso.com', junk: true })), { action: 'skip', reason: 'junk' })
  })

  it("applies the organizer's update unless it is older, and refuses one from anyone else", () => {
    const invite = parseIcs(OUTLOOK_REQUEST)!
    const copy = { ...invite.event!, id: 'E2' } as StoredEvent
    assert.deepEqual(decide(invite, copy, ctx({ from: 'kim@contoso.com' })), { action: 'update', whole: true, occurrences: ['2026-12-01T15:00:00'] })
    assert.deepEqual(decide(invite, { ...copy, sequence: 4 }, ctx({ from: 'kim@contoso.com' })), { action: 'skip', reason: 'older_sequence' })
    assert.deepEqual(decide(invite, copy, ctx({ from: 'mallory@contoso.com' })), { action: 'skip', reason: 'not_organizer' })
  })

  it("cancels on the organizer's word, and ignores invitations to our own events", () => {
    const series = parseIcs(OUTLOOK_REQUEST)!.event!
    const cancel = parseIcs(buildIcs({ method: 'CANCEL', event: { ...series, id: 'x' } as StoredEvent }))!
    assert.deepEqual(decide(cancel, { ...series, id: 'E2' } as StoredEvent, ctx({ from: 'kim@contoso.com' })), { action: 'cancel', occurrences: [] })
    const ownInvite = parseIcs(buildIcs({ method: 'REQUEST', event: ours() }))!
    assert.deepEqual(decide(ownInvite, ours(), ctx({ from: HELLO })), { action: 'skip', reason: 'own_event' })
  })

  it('says when the time moved', () => {
    assert.equal(timeMoved(ours(), ours({ title: 'renamed' })), false)
    assert.equal(timeMoved(ours(), ours({ start: '2026-11-24T16:00:00' })), true)
  })
})
