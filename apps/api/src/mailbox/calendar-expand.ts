// Repeating events and the time columns for events kept in a mailbox's store (docs/mailbox-store-plan.md, phase 3a).
// Events are JSCalendar, as ../mailserver/calendar-events.ts reads them: a series is stored
// once and expanded here into the occurrences a range needs, with its per-occurrence changes applied. Occurrences are
// counted in local (wall-clock) time with ical.js, then each is placed in UTC with its time zone, so daylight saving
// moves them the way the people in that zone expect. Pure: no runtime imports, so `pnpm test` runs it under Node.

import ICAL from 'ical.js'
import { addMinutes, durationMinutes, withSeconds, zonedToUtc } from '../mailserver/calendar-events.ts'
import type { StoredEvent, StoredRecurrenceRule } from '../mailserver/calendar-types'

/** A series is never expanded past this many occurrences in one go (a daily event from 1990 still fits). */
const MAX_STEPS = 20_000

/** An occurrence's id: its series and its original local start, e.g. `01J….20261118T093000`. */
export function occurrenceId(seriesId: string, recurrenceId: string): string {
  return `${seriesId}.${withSeconds(recurrenceId).replace(/[-:]/g, '')}`
}

/** The series and original local start in an occurrence id, or null for a plain event id. */
export function parseOccurrenceId(id: string): { seriesId: string; recurrenceId: string } | null {
  const m = /^(.+)\.(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(id)
  if (!m) return null
  return { seriesId: m[1]!, recurrenceId: `${m[2]}-${m[3]}-${m[4]}T${m[5]}:${m[6]}:${m[7]}` }
}

/** A JSCalendar repeat rule as an iCalendar RRULE value (without "RRULE:"). Null when it has no frequency. */
export function toRrule(rule: StoredRecurrenceRule | Record<string, unknown> | null | undefined): string | null {
  const r = (rule ?? {}) as Record<string, unknown>
  const frequency = typeof r.frequency === 'string' ? r.frequency.toUpperCase() : null
  if (!frequency) return null
  const parts = [`FREQ=${frequency}`]
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(',') : '')
  if (typeof r.interval === 'number' && r.interval > 1) parts.push(`INTERVAL=${r.interval}`)
  if (Array.isArray(r.byDay) && r.byDay.length) {
    const days = (r.byDay as { day: string; nthOfPeriod?: number }[]).map((d) => `${d.nthOfPeriod ?? ''}${d.day.toUpperCase()}`)
    parts.push(`BYDAY=${days.join(',')}`)
  }
  if (list(r.byMonthDay)) parts.push(`BYMONTHDAY=${list(r.byMonthDay)}`)
  // JSCalendar months are strings ("1", or "3L" for a leap month); plain numbers are all ical.js needs.
  if (list(r.byMonth)) parts.push(`BYMONTH=${(r.byMonth as unknown[]).map((m) => parseInt(String(m), 10)).filter(Number.isFinite).join(',')}`)
  if (list(r.byYearDay)) parts.push(`BYYEARDAY=${list(r.byYearDay)}`)
  if (list(r.byWeekNo)) parts.push(`BYWEEKNO=${list(r.byWeekNo)}`)
  if (list(r.byHour)) parts.push(`BYHOUR=${list(r.byHour)}`)
  if (list(r.byMinute)) parts.push(`BYMINUTE=${list(r.byMinute)}`)
  if (list(r.bySetPosition)) parts.push(`BYSETPOS=${list(r.bySetPosition)}`)
  if (typeof r.firstDayOfWeek === 'string') parts.push(`WKST=${r.firstDayOfWeek.toUpperCase()}`)
  if (typeof r.count === 'number') parts.push(`COUNT=${r.count}`)
  else if (typeof r.until === 'string') parts.push(`UNTIL=${withSeconds(r.until).replace(/[-:]/g, '')}`)
  return parts.join(';')
}

/** A local start as UTC: in its zone, or as if it were UTC for all-day and floating events. */
function utcOf(local: string, timeZone: string | null | undefined, allDay: boolean): string {
  return allDay || !timeZone ? `${withSeconds(local)}Z` : zonedToUtc(local, timeZone)
}

function utcEndOf(utcStart: string, duration: string | undefined, allDay: boolean): string {
  const minutes = durationMinutes(duration ?? (allDay ? 'P1D' : 'PT0S'))
  return `${addMinutes(utcStart.replace(/Z$/, ''), minutes)}Z`
}

/** A single event (or a series' first occurrence) with its UTC times. */
export function withTimes(e: StoredEvent): StoredEvent {
  const allDay = !!e.showWithoutTime
  const utcStart = utcOf(e.start, e.timeZone, allDay)
  return { ...e, utcStart, utcEnd: utcEndOf(utcStart, e.duration, allDay) }
}

/** The local starts of a series in order, from its own start, up to (not including) `untilLocal` if given. */
function* localStarts(e: StoredEvent, untilLocal?: string): Generator<string> {
  const rrule = toRrule(e.recurrenceRule)
  if (!rrule) {
    yield withSeconds(e.start)
    return
  }
  let iterator: ICAL.RecurIterator
  try {
    iterator = ICAL.Recur.fromString(rrule).iterator(ICAL.Time.fromDateTimeString(withSeconds(e.start)))
  } catch {
    // A rule ical.js can't read: show the first occurrence rather than nothing.
    yield withSeconds(e.start)
    return
  }
  for (let steps = 0, next = iterator.next(); next && steps < MAX_STEPS; steps++, next = iterator.next()) {
    const local = next.toString().slice(0, 19)
    if (untilLocal && local >= untilLocal) return
    yield local
  }
}

/**
 * One occurrence of a series: its own id, `baseEventId`, `recurrenceId`, the
 * series' fields with this occurrence's changes on top, and UTC times. Null when that occurrence was deleted.
 */
export function occurrenceOf(series: StoredEvent, recurrenceId: string): StoredEvent | null {
  const key = withSeconds(recurrenceId)
  const change = (series.recurrenceOverrides ?? {})[key] as Record<string, unknown> | undefined
  if (change?.excluded) return null
  const { recurrenceRule: _rule, recurrenceOverrides: _overrides, ...base } = series
  const occurrence = { ...base, ...(change ?? {}), start: (change?.start as string | undefined) ?? key } as StoredEvent
  return withTimes({ ...occurrence, id: occurrenceId(series.id, key), baseEventId: series.id, recurrenceId: key })
}

/** An occurrence as it was before it was deleted (for telling guests which one was cancelled). */
export function cancelledOccurrence(series: StoredEvent, recurrenceId: string): StoredEvent | null {
  const key = withSeconds(recurrenceId)
  const { excluded: _gone, ...change } = ((series.recurrenceOverrides ?? {})[key] ?? {}) as Record<string, unknown>
  return occurrenceOf({ ...series, recurrenceOverrides: { ...(series.recurrenceOverrides ?? {}), [key]: change } }, key)
}

/**
 * The event's entries overlapping [afterMs, beforeMs): itself for a single event, its occurrences for a series
 * (moved ones where they were moved to, deleted ones left out), sorted by start.
 */
export function expand(e: StoredEvent, afterMs: number, beforeMs: number): StoredEvent[] {
  const overlaps = (x: StoredEvent) => Date.parse(x.utcStart!) < beforeMs && (Date.parse(x.utcEnd!) > afterMs || (x.utcEnd === x.utcStart && Date.parse(x.utcStart!) >= afterMs))
  if (!e.recurrenceRule) {
    const single = withTimes(e)
    return overlaps(single) ? [single] : []
  }
  // Counted in local time: stop well past the range so any zone and the longest event are covered.
  const allDay = !!e.showWithoutTime
  const span = durationMinutes(e.duration ?? (allDay ? 'P1D' : 'PT0S'))
  const earliest = new Date(afterMs - (span + 15 * 60) * 60_000).toISOString().slice(0, 19)
  const latest = new Date(beforeMs + 15 * 3600_000).toISOString().slice(0, 19)
  const keys = new Set<string>()
  const out: StoredEvent[] = []
  for (const local of localStarts(e, latest)) {
    keys.add(local)
    if (local < earliest) continue
    const o = occurrenceOf(e, local)
    if (o && overlaps(o)) out.push(o)
  }
  // An occurrence moved into the range from a start outside the part walked above.
  for (const key of Object.keys(e.recurrenceOverrides ?? {})) {
    if (keys.has(key)) continue
    const o = occurrenceOf(e, key)
    if (o && o.start !== key && overlaps(o)) out.push(o)
  }
  return out.sort((a, b) => a.utcStart!.localeCompare(b.utcStart!))
}

/**
 * Where an event sits in time, for finding it by range: a single event's real start and end; a series' first start
 * and the end of its last occurrence, or null when it never ends. Moved occurrences widen the span.
 */
export function timeColumns(e: StoredEvent): { startUtc: string; endUtc: string | null; recurring: boolean } {
  const first = withTimes(e)
  if (!e.recurrenceRule) return { startUtc: first.utcStart!, endUtc: first.utcEnd!, recurring: false }
  const rule = e.recurrenceRule as Record<string, unknown>
  if (typeof rule.count !== 'number' && typeof rule.until !== 'string') return { startUtc: first.utcStart!, endUtc: null, recurring: true }
  let last: string | null = null
  for (const local of localStarts(e)) last = local
  let end = last ? withTimes({ ...e, start: last }).utcEnd! : first.utcEnd!
  let start = first.utcStart!
  for (const [key, change] of Object.entries(e.recurrenceOverrides ?? {})) {
    if ((change as Record<string, unknown>).excluded) continue
    const o = occurrenceOf(e, key)
    if (!o) continue
    if (o.utcEnd! > end) end = o.utcEnd!
    if (o.utcStart! < start) start = o.utcStart!
  }
  return { startUtc: start, endUtc: end, recurring: true }
}

/**
 * Applies a JMAP patch: each key is a path ("title", "participants/g1/participationStatus"), each value replaces
 * what is there, and null removes it. Returns a new object.
 */
export function applyPatch<T extends Record<string, unknown>>(target: T, patch: Record<string, unknown>): T {
  const out = structuredClone(target) as Record<string, unknown>
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.split('/').map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    let node = out
    for (const key of keys.slice(0, -1)) {
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
      node = node[key] as Record<string, unknown>
    }
    const last = keys.at(-1)!
    if (value === null) delete node[last]
    else node[last] = structuredClone(value)
  }
  return out as T
}

/** Fields whose change is news for guests: an update to any of them raises the event's sequence. */
const SCHEDULING_FIELDS = new Set(['title', 'description', 'start', 'duration', 'timeZone', 'showWithoutTime', 'locations', 'participants', 'recurrenceRule', 'recurrenceOverrides', 'status'])

/** Whether a patch changes what guests were told (a guest's own answer, deeper in participants, doesn't). */
export function changesSchedule(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some((path) => SCHEDULING_FIELDS.has(path))
}
