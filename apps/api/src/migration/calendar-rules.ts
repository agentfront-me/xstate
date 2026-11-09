// A Google Calendar event as a JSCalendar event for Stalwart. Pure (tested in calendar-rules.test.ts); the copy job
// is ./calendar.ts. Times stay in the event's own zone, repeat rules are translated from Google's RRULE lines, and
// the person's own Google address becomes their xstate address on the guest list.

import { toDuration, withSeconds } from '../mailserver/calendar-events.ts'
import type { GAttendee, GEvent, GEventTime } from './google/workspace'

/** Stalwart stores at most this many participants per event, the organizer included. */
export const MAX_PARTICIPANTS = 20

export type ConvertContext = {
  /** The calendar's zone, for times Google sends without one. */
  timeZone: string
  /** The person's Google address(es) and their xstate address: their own entries become the latter. */
  googleAddresses: string[]
  address: string
}

export type Converted = {
  fields: Record<string, unknown>
  /** Guests left off because Stalwart stores at most 20 participants. */
  trimmed: number
}

/** Why an event isn't copied, or null when it is. */
export function skipReason(e: GEvent): string | null {
  if (e.status === 'cancelled') return 'cancelled'
  if (e.eventType === 'workingLocation') return 'working_location'
  if (e.eventType === 'birthday') return 'birthday'
  if (!e.start || !e.end) return 'no_time'
  return null
}

/** A single event or a repeating series (not a changed occurrence: see occurrenceOverride). */
export function convertEvent(e: GEvent, ctx: ConvertContext): Converted {
  const zone = e.start?.timeZone || ctx.timeZone
  const fields: Record<string, unknown> = {
    '@type': 'Event',
    uid: e.iCalUID || `${e.id}@google.com`,
    sequence: e.sequence ?? 0,
    title: e.summary ?? '',
    description: e.description ?? '',
    locations: e.location ? { l: { '@type': 'Location', name: e.location } } : null,
    ...timeOf(e.start!, e.end!, zone),
  }
  if (e.status === 'tentative') fields.status = 'tentative'
  if (e.transparency === 'transparent') fields.freeBusyStatus = 'free'

  const rrule = e.recurrence?.find((line) => /^RRULE[:;]/i.test(line))
  if (rrule) {
    const rule = parseRrule(rrule)
    if (rule) fields.recurrenceRule = rule
  }
  const excluded = (e.recurrence ?? []).filter((line) => /^EXDATE[:;]/i.test(line)).flatMap((line) => exdateKeys(line, zone, !!e.start!.date))
  if (excluded.length) fields.recurrenceOverrides = Object.fromEntries(excluded.map((k) => [k, { excluded: true }]))

  const { participants, organizer, trimmed } = participantsOf(e, ctx)
  if (participants) {
    fields.participants = participants
    if (organizer) fields.organizerCalendarAddress = `mailto:${organizer}`
  }
  if (trimmed) fields.description = `${fields.description ? `${fields.description}\n\n` : ''}(${trimmed} more guests weren't copied from Google: an xstate event holds at most ${MAX_PARTICIPANTS} people.)`
  return { fields, trimmed }
}

/**
 * A changed or cancelled occurrence of a series, as an entry of the series' recurrenceOverrides. `seriesZone` is
 * the series' timeZone (null for all-day series): the key is the occurrence's original start in that zone.
 */
export function occurrenceOverride(e: GEvent, seriesZone: string | null, seriesDuration: string | null): { key: string; value: Record<string, unknown> } | null {
  const original = e.originalStartTime
  if (!original) return null
  const key = original.date ? `${original.date}T00:00:00` : utcToZoned(original.dateTime!, seriesZone ?? original.timeZone ?? 'Etc/UTC')
  if (e.status === 'cancelled') return { key, value: { excluded: true } }
  const value: Record<string, unknown> = {}
  if (e.summary !== undefined) value.title = e.summary
  if (e.description !== undefined) value.description = e.description
  if (e.location !== undefined) value.locations = e.location ? { l: { '@type': 'Location', name: e.location } } : null
  if (e.start && e.end) {
    const t = timeOf(e.start, e.end, seriesZone ?? e.start.timeZone ?? 'Etc/UTC')
    if (t.start !== key) value.start = t.start
    if (t.duration !== seriesDuration) value.duration = t.duration
  }
  return { key, value }
}

// ---------------------------------------------------------------------------------------------------------------
// Times

function timeOf(start: GEventTime, end: GEventTime, zone: string) {
  if (start.date) {
    const days = Math.max(1, Math.round((Date.parse(`${end.date ?? start.date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`)) / 86400000))
    return { start: `${start.date}T00:00:00`, duration: `P${days}D`, showWithoutTime: true, timeZone: null }
  }
  const minutes = Math.max(0, Math.round((Date.parse(end.dateTime!) - Date.parse(start.dateTime!)) / 60000))
  return { start: utcToZoned(start.dateTime!, zone), duration: toDuration(minutes), showWithoutTime: false, timeZone: zone }
}

/** An instant (any RFC 3339 offset) as wall-clock time in a zone: YYYY-MM-DDTHH:mm:ss. Unknown zones give UTC. */
export function utcToZoned(instant: string, timeZone: string): string {
  const ms = Date.parse(instant)
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(new Date(ms))
        .map((x) => [x.type, x.value]),
    )
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
  } catch {
    return new Date(ms).toISOString().slice(0, 19)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Repeat rules

const DAYS = new Set(['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'])
const FREQUENCIES = new Set(['yearly', 'monthly', 'weekly', 'daily', 'hourly', 'minutely', 'secondly'])

/** An RRULE line ("RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10") as a JSCalendar RecurrenceRule, or null. */
export function parseRrule(line: string): Record<string, unknown> | null {
  const body = line.replace(/^RRULE[:;]/i, '')
  const parts = Object.fromEntries(
    body
      .split(';')
      .map((kv) => kv.split('='))
      .filter((kv) => kv.length === 2)
      .map(([k, v]) => [k!.toUpperCase(), v!]),
  )
  const frequency = parts.FREQ?.toLowerCase()
  if (!frequency || !FREQUENCIES.has(frequency)) return null
  const rule: Record<string, unknown> = { '@type': 'RecurrenceRule', frequency }
  const ints = (v?: string) => (v ? v.split(',').map(Number).filter((n) => Number.isInteger(n)) : [])
  if (parts.INTERVAL && Number(parts.INTERVAL) > 1) rule.interval = Number(parts.INTERVAL)
  if (parts.COUNT) rule.count = Number(parts.COUNT)
  else if (parts.UNTIL) rule.until = untilOf(parts.UNTIL)
  if (parts.BYDAY) {
    const byDay = parts.BYDAY.split(',')
      .map((d) => /^([+-]?\d{1,2})?([A-Z]{2})$/i.exec(d.trim()))
      .filter((m): m is RegExpExecArray => !!m && DAYS.has(m[2]!.toLowerCase()))
      .map((m) => ({ '@type': 'NDay', day: m[2]!.toLowerCase(), ...(m[1] && { nthOfPeriod: Number(m[1]) }) }))
    if (byDay.length) rule.byDay = byDay
  }
  if (ints(parts.BYMONTHDAY).length) rule.byMonthDay = ints(parts.BYMONTHDAY)
  if (ints(parts.BYMONTH).length) rule.byMonth = ints(parts.BYMONTH).map(String)
  if (ints(parts.BYYEARDAY).length) rule.byYearDay = ints(parts.BYYEARDAY)
  if (ints(parts.BYWEEKNO).length) rule.byWeekNo = ints(parts.BYWEEKNO)
  if (ints(parts.BYSETPOS).length) rule.bySetPosition = ints(parts.BYSETPOS)
  if (parts.WKST && DAYS.has(parts.WKST.toLowerCase())) rule.firstDayOfWeek = parts.WKST.toLowerCase()
  return rule
}

/**
 * UNTIL as a local date-time. Google writes it in UTC (…Z) for timed series or as a date for all-day ones; JSCalendar
 * reads it in the event's zone, so a UTC value is kept as is: it can only end the series a few hours late.
 */
function untilOf(v: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v)
  if (!m) return v
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '23'}:${m[5] ?? '59'}:${m[6] ?? '59'}`
}

/** EXDATE keys as local start times in the series' zone. Handles TZID=, UTC (…Z) and VALUE=DATE forms. */
export function exdateKeys(line: string, zone: string, allDay: boolean): string[] {
  const colon = line.indexOf(':')
  if (colon < 0) return []
  const params = line.slice(0, colon)
  const tzid = /TZID=([^;:]+)/i.exec(params)?.[1]
  return line
    .slice(colon + 1)
    .split(',')
    .map((v) => v.trim())
    .flatMap((v) => {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v)
      if (!m) return []
      const date = `${m[1]}-${m[2]}-${m[3]}`
      if (!m[4] || allDay) return [`${date}T00:00:00`]
      const local = `${date}T${m[4]}:${m[5]}:${m[6]}`
      if (m[7]) return [utcToZoned(`${local}Z`, zone)]
      // Written in another zone than the series': convert through UTC.
      if (tzid && tzid !== zone) return [utcToZoned(zonedInstant(local, tzid), zone)]
      return [local]
    })
}

/** A wall-clock time in a zone as an ISO instant. */
function zonedInstant(local: string, zone: string): string {
  const guess = Date.parse(`${withSeconds(local)}Z`)
  const offset = (t: number) => Date.parse(`${utcToZoned(new Date(t).toISOString(), zone)}Z`) - t
  let t = guess - offset(guess)
  t = guess - offset(t)
  return new Date(t).toISOString()
}

// ---------------------------------------------------------------------------------------------------------------
// Guests

const STATUS: Record<string, string> = { needsAction: 'needs-action', accepted: 'accepted', declined: 'declined', tentative: 'tentative' }

function participantsOf(e: GEvent, ctx: ConvertContext): { participants: Record<string, unknown> | null; organizer: string | null; trimmed: number } {
  const own = new Set(ctx.googleAddresses.map((a) => a.toLowerCase()))
  const mine = (email?: string, self?: boolean) => self || (!!email && own.has(email.toLowerCase()))
  const addressOf = (email: string, self?: boolean) => (mine(email, self) ? ctx.address : email.toLowerCase())

  const people = (e.attendees ?? []).filter((a): a is GAttendee & { email: string } => !!a.email && !a.resource)
  const organizerEmail = e.organizer?.email ? addressOf(e.organizer.email, e.organizer.self) : null
  // No guests and organized by the person themself: a plain event without a guest list.
  if (!people.length && (!organizerEmail || organizerEmail === ctx.address)) return { participants: null, organizer: null, trimmed: 0 }

  type Entry = { email: string; name: string | null; status: string; organizer: boolean; optional: boolean; self: boolean }
  const byEmail = new Map<string, Entry>()
  for (const a of people) {
    const email = addressOf(a.email, a.self)
    byEmail.set(email, {
      email,
      name: a.displayName ?? null,
      status: STATUS[a.responseStatus ?? 'needsAction'] ?? 'needs-action',
      organizer: !!a.organizer || email === organizerEmail,
      optional: !!a.optional,
      self: email === ctx.address,
    })
  }
  if (organizerEmail && !byEmail.has(organizerEmail)) {
    byEmail.set(organizerEmail, { email: organizerEmail, name: e.organizer?.displayName ?? null, status: 'accepted', organizer: true, optional: false, self: organizerEmail === ctx.address })
  }
  // Over the limit: keep the organizer and the person, then the others in Google's order.
  const all = [...byEmail.values()]
  const kept = [...all.filter((p) => p.organizer || p.self), ...all.filter((p) => !p.organizer && !p.self)].slice(0, MAX_PARTICIPANTS)
  const participants: Record<string, unknown> = {}
  kept.forEach((p, i) => {
    const roles: Record<string, true> = { attendee: true }
    if (p.organizer) roles.owner = true
    if (p.optional) roles.optional = true
    participants[`p${i + 1}`] = {
      '@type': 'Participant',
      ...(p.name && { name: p.name }),
      calendarAddress: `mailto:${p.email}`,
      roles,
      participationStatus: p.status,
    }
  })
  return { participants, organizer: organizerEmail, trimmed: all.length - kept.length }
}
