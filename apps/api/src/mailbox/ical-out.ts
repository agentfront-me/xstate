// Invitation files (iCalendar, RFC 5545, with iTIP methods, RFC 5546) for events kept in a mailbox's store
// (docs/mailbox-store-plan.md, phase 3b). Built from the JSCalendar event as jCal (RFC 7265) and written out by
// ical.js, which handles escaping and line folding. Time zones get a VTIMEZONE made from the runtime's own zone data,
// because Outlook refuses a TZID it can't find in the file. Pure: no runtime imports, so `pnpm test` runs it.

import ICAL from 'ical.js'
import { addDays, addMinutes, durationMinutes, mailto, withSeconds, zoneOffsetMinutes, zonedToUtc } from '../mailserver/calendar-events.ts'
import type { JmapEvent, JmapParticipant } from '../mailserver/stalwart/calendar'
import { occurrenceOf, timeColumns, toRrule } from './calendar-expand.ts'

export type ItipMethod = 'REQUEST' | 'CANCEL' | 'REPLY'

type JCalProp = [string, Record<string, string>, string, ...unknown[]]
type JCalComp = [string, JCalProp[], JCalComp[]]

const PRODID = '-//xstate//Calendar//EN'
const YEAR_MS = 366 * 86_400_000

export type BuildOptions = {
  method: ItipMethod
  /** The series (or single event) as stored, with its overrides. */
  event: JmapEvent
  /** REPLY: the replying mailbox's own address; only its attendee line is sent. */
  replyFrom?: string
  /** CANCEL of one occurrence: its original local start (a recurrence id). */
  occurrence?: string
  /** For tests: the time stamped on the file. */
  now?: Date
}

/** The iCalendar text for an invitation, update, cancellation or answer. CRLF line endings. */
export function buildIcs(o: BuildOptions): string {
  const e = o.event
  const zone = !e.showWithoutTime && e.timeZone ? e.timeZone : null
  const stamp = utcStamp(o.now ?? new Date())
  const events: JCalComp[] = []

  if (o.method === 'CANCEL' && o.occurrence) {
    const one = occurrenceOf({ ...e, recurrenceOverrides: { ...(e.recurrenceOverrides ?? {}), [withSeconds(o.occurrence)]: {} } }, o.occurrence)
    if (one) events.push(vevent(one, o, stamp, zone, { recurrenceId: o.occurrence, status: 'CANCELLED' }))
  } else {
    const main = vevent(e, o, stamp, zone, { status: o.method === 'CANCEL' ? 'CANCELLED' : undefined })
    if (e.recurrenceRule && o.method !== 'REPLY') {
      const rrule = recurValue(e, zone)
      if (rrule) main[1].push(['rrule', {}, 'recur', rrule])
      for (const [key, change] of Object.entries(e.recurrenceOverrides ?? {})) {
        if ((change as Record<string, unknown>).excluded) main[1].push(timeProp('exdate', key, zone, !!e.showWithoutTime))
      }
    }
    events.push(main)
    // A changed occurrence travels as its own VEVENT next to the series (not in a reply or a cancellation).
    if (e.recurrenceRule && o.method === 'REQUEST') {
      for (const [key, change] of Object.entries(e.recurrenceOverrides ?? {})) {
        if ((change as Record<string, unknown>).excluded) continue
        const one = occurrenceOf(e, key)
        if (one) events.push(vevent(one, o, stamp, zone, { recurrenceId: key }))
      }
    }
  }

  const components: JCalComp[] = []
  if (zone) components.push(vtimezone(zone, ...zoneSpan(e)))
  components.push(...events)
  const calendar: JCalComp = [
    'vcalendar',
    [
      ['prodid', {}, 'text', PRODID],
      ['version', {}, 'text', '2.0'],
      ['calscale', {}, 'text', 'GREGORIAN'],
      ['method', {}, 'text', o.method],
    ],
    components,
  ]
  return new ICAL.Component(calendar as unknown as unknown[]).toString().replace(/\r?\n/g, '\r\n') + '\r\n'
}

function vevent(e: JmapEvent, o: BuildOptions, stamp: string, zone: string | null, extra: { recurrenceId?: string; status?: string }): JCalComp {
  const allDay = !!e.showWithoutTime
  const props: JCalProp[] = [
    ['uid', {}, 'text', e.uid ?? e.id],
    ['dtstamp', {}, 'date-time', stamp],
    ['sequence', {}, 'integer', e.sequence ?? 0],
  ]
  if (extra.recurrenceId) props.push(timeProp('recurrence-id', extra.recurrenceId, zone, allDay))
  props.push(timeProp('dtstart', e.start, zone, allDay))
  const minutes = durationMinutes(e.duration ?? (allDay ? 'P1D' : 'PT0S'))
  props.push(allDay ? timeProp('dtend', addDays(e.start.slice(0, 10), Math.max(1, Math.round(minutes / 1440))), null, true) : timeProp('dtend', addMinutes(e.start, minutes), zone, false))
  if (o.method !== 'REPLY') {
    props.push(['summary', {}, 'text', e.title ?? ''])
    if (e.description) props.push(['description', {}, 'text', e.description])
    const location = Object.values(e.locations ?? {})[0]?.name
    if (location) props.push(['location', {}, 'text', location])
  }
  const status = extra.status ?? (e.status === 'cancelled' ? 'CANCELLED' : e.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED')
  if (o.method !== 'REPLY') props.push(['status', {}, 'text', status])

  const people = Object.values(e.participants ?? {})
  const owner = people.find((p) => p.roles?.owner)
  const organizer = mailto(e.organizerCalendarAddress) ?? mailto(owner?.calendarAddress)
  if (organizer) props.push(['organizer', owner?.name ? { cn: owner.name } : {}, 'cal-address', `mailto:${organizer}`])
  const attendees = o.method === 'REPLY' ? people.filter((p) => mailto(p.calendarAddress) === o.replyFrom?.toLowerCase()) : people.filter((p) => mailto(p.calendarAddress))
  for (const p of attendees) props.push(attendee(p, o.method))
  return ['vevent', props, []]
}

function attendee(p: JmapParticipant, method: ItipMethod): JCalProp {
  const params: Record<string, string> = {}
  if (p.name) params.cn = p.name
  params.role = p.roles?.owner ? 'CHAIR' : p.roles?.optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT'
  params.partstat = PARTSTAT[p.participationStatus ?? 'needs-action'] ?? 'NEEDS-ACTION'
  if (method === 'REQUEST' && !p.roles?.owner) params.rsvp = 'TRUE'
  return ['attendee', params, 'cal-address', `mailto:${mailto(p.calendarAddress)}`]
}

const PARTSTAT: Record<string, string> = { accepted: 'ACCEPTED', declined: 'DECLINED', tentative: 'TENTATIVE', 'needs-action': 'NEEDS-ACTION' }

/** A DTSTART-like property: a date for all-day, local time with TZID in a zone, else UTC. */
function timeProp(name: string, local: string, zone: string | null, allDay: boolean): JCalProp {
  if (allDay) return [name, {}, 'date', local.slice(0, 10)]
  if (zone) return [name, { tzid: zone }, 'date-time', withSeconds(local)]
  return [name, {}, 'date-time', `${withSeconds(local)}Z`]
}

/** The RRULE as jCal: the 3a converter's rule, with UNTIL in UTC for a zoned series (RFC 5545 requires it). */
function recurValue(e: JmapEvent, zone: string | null): unknown {
  const rule = toRrule(e.recurrenceRule)
  if (!rule) return null
  const fixed = rule.replace(/UNTIL=(\d{8})T(\d{6})/, (_, d: string, t: string) => {
    if (e.showWithoutTime) return `UNTIL=${d}`
    const local = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`
    const utc = zone ? zonedToUtc(local, zone) : `${local}Z`
    return `UNTIL=${utc.replace(/[-:]/g, '')}`
  })
  return ICAL.Recur.fromString(fixed).toJSON()
}

function utcStamp(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`
}

// ---------------------------------------------------------------------------------------------------------------
// VTIMEZONE

/** The span of time the zone block has to cover: from a year before the event to a year after it ends (5 for open series). */
function zoneSpan(e: JmapEvent): [number, number] {
  const time = timeColumns(e)
  const start = Date.parse(time.startUtc)
  const end = time.endUtc ? Date.parse(time.endUtc) : Math.max(start, Date.now()) + 4 * YEAR_MS
  return [start - YEAR_MS, end + YEAR_MS]
}

/**
 * A VTIMEZONE for an IANA zone between two instants: the offset in force at the start, then one observance per change
 * of offset, each found to the minute by probing the runtime's zone data. Changes to a larger offset are DAYLIGHT.
 */
export function vtimezone(zone: string, fromMs: number, toMs: number): JCalComp {
  const offset = (ms: number) => zoneOffsetMinutes(zone, ms)
  const changes: { at: number; from: number; to: number }[] = []
  const DAY = 86_400_000
  let previous = offset(fromMs)
  for (let t = fromMs + DAY; t <= toMs; t += DAY) {
    const now = offset(t)
    if (now === previous) continue
    // The change happened within the last day: narrow it to the minute.
    let lo = t - DAY
    let hi = t
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000
      if (offset(mid) === previous) lo = mid
      else hi = mid
    }
    changes.push({ at: hi, from: previous, to: now })
    previous = now
  }
  const first = offset(fromMs)
  const observances: JCalComp[] = [observance(changes.length && changes[0]!.to > first ? 'standard' : changes.length ? 'daylight' : 'standard', fromMs, first, first)]
  for (const c of changes) observances.push(observance(c.to > c.from ? 'daylight' : 'standard', c.at, c.from, c.to))
  return ['vtimezone', [['tzid', {}, 'text', zone]], observances]
}

/** One STANDARD or DAYLIGHT block: its DTSTART is the local time just before the change, in the old offset. */
function observance(kind: 'standard' | 'daylight', atMs: number, from: number, to: number): JCalComp {
  const local = new Date(atMs + from * 60_000).toISOString().slice(0, 19)
  return [
    kind,
    [
      ['dtstart', {}, 'date-time', local],
      ['tzoffsetfrom', {}, 'utc-offset', utcOffset(from)],
      ['tzoffsetto', {}, 'utc-offset', utcOffset(to)],
    ],
    [],
  ]
}

function utcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const m = Math.abs(minutes)
  return `${sign}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
