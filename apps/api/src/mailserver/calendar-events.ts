// Turning Stalwart's JSCalendar events into the flat events the API returns, and the API's input back into
// JSCalendar. No runtime imports, so `pnpm test` runs this file directly under Node.

import type { JmapEvent, JmapParticipant, JmapRecurrenceRule } from './stalwart/calendar'

export type GuestStatus = 'needs-action' | 'accepted' | 'declined' | 'tentative'
export type Guest = { email: string; name: string | null; organizer: boolean; optional: boolean; status: GuestStatus }

export const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const
export type Weekday = (typeof WEEKDAYS)[number]
export type Repeat = {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  /** Weekly only: which days. Empty means the start's weekday. */
  days: Weekday[]
  /** Last date it can happen on (YYYY-MM-DD), or null. */
  until: string | null
  /** How many times in total, or null. */
  count: number | null
}

export type CalendarEvent = {
  /** Pass this to get, update, delete and RSVP. For one occurrence of a repeating event it is that occurrence's id. */
  id: string
  /** The repeating event this is an occurrence of, else null. */
  seriesId: string | null
  /** Which occurrence (its original local start), for editing just this one. Null when not an occurrence. */
  occurrence: string | null
  calendarId: string
  /** cancelled: the organizer called it off; it stays in a guest's calendar until they delete it. */
  status: 'confirmed' | 'tentative' | 'cancelled'
  title: string
  description: string
  location: string
  allDay: boolean
  /**
   * Timed events: UTC instants (…Z). All-day events: dates (YYYY-MM-DD), end exclusive.
   * Ready to hand to a calendar grid.
   */
  start: string
  end: string
  /** As entered, in timeZone: local start (YYYY-MM-DDTHH:mm, or a date for all-day) and end. For the editor. */
  localStart: string
  localEnd: string
  /** IANA zone, null for all-day and floating events. */
  timeZone: string | null
  repeat: Repeat | null
  guests: Guest[]
  /** The organizer's email, null for an event without guests. */
  organizer: string | null
  /** Whether this mailbox organizes it (may change time and guests) rather than being invited. */
  isOrganizer: boolean
  /** This mailbox's own answer when invited, else null. */
  myStatus: GuestStatus | null
  updatedAt: string | null
}

export type EventInput = {
  calendarId?: string
  title: string
  description?: string
  location?: string
  allDay: boolean
  /** Local time in timeZone (YYYY-MM-DDTHH:mm[:ss]), or a date (YYYY-MM-DD) when allDay. */
  start: string
  /** Same form as start. For all-day events, the last day (inclusive), as people type it. */
  end: string
  timeZone?: string
  repeat?: {
    frequency: Repeat['frequency']
    interval?: number
    days?: Weekday[]
    until?: string | null
    count?: number | null
  } | null
  guests?: { email: string; name?: string | null; optional?: boolean }[]
}

const STATUSES: GuestStatus[] = ['needs-action', 'accepted', 'declined', 'tentative']

// ---------------------------------------------------------------------------------------------------------------
// Stalwart → API

/** `addresses`: the mailbox's own addresses (lowercase), to tell its own participant entry apart. */
export function toEvent(e: JmapEvent, addresses: string[]): CalendarEvent {
  const allDay = !!e.showWithoutTime
  const localStart = trimSeconds(e.start)
  const minutes = durationMinutes(e.duration ?? (allDay ? 'P1D' : 'PT0S'))
  const localEndFull = addMinutes(e.start, minutes)
  const guests = toGuests(e.participants)
  const mine = guests.find((g) => addresses.includes(g.email))
  const organizer = mailto(e.organizerCalendarAddress) ?? guests.find((g) => g.organizer)?.email ?? null

  let start: string
  let end: string
  if (allDay) {
    start = e.start.slice(0, 10)
    end = localEndFull.slice(0, 10)
  } else {
    // Stalwart gives UTC times for stored events; a parsed invite has only the local time and its zone.
    start = e.utcStart ?? (e.timeZone ? zonedToUtc(e.start, e.timeZone) : `${withSeconds(e.start)}Z`)
    end = e.utcEnd ?? `${addMinutes(start.replace(/Z$/, ''), minutes)}Z`
  }

  return {
    id: e.id,
    seriesId: e.baseEventId ?? null,
    occurrence: e.recurrenceId ? trimSeconds(e.recurrenceId) : null,
    calendarId: Object.keys(e.calendarIds ?? {})[0] ?? '',
    status: e.status === 'cancelled' || e.status === 'tentative' ? e.status : 'confirmed',
    title: e.title ?? '',
    description: e.description ?? '',
    location: Object.values(e.locations ?? {})[0]?.name ?? '',
    allDay,
    start,
    end,
    localStart: allDay ? localStart.slice(0, 10) : localStart,
    // People think of an all-day event's last day, not the day after it.
    localEnd: allDay ? addDays(localEndFull.slice(0, 10), -1) : trimSeconds(localEndFull),
    timeZone: allDay ? null : (e.timeZone ?? null),
    repeat: toRepeat(e.recurrenceRule),
    guests,
    organizer,
    isOrganizer: !organizer || addresses.includes(organizer),
    myStatus: mine && !mine.organizer ? mine.status : null,
    updatedAt: e.updated ?? null,
  }
}

/** Everyone on the event, organizer first. Empty when nobody but the organizer is left (Stalwart keeps them). */
function toGuests(participants: JmapEvent['participants']): Guest[] {
  const guests = Object.values(participants ?? {})
    .map((p): Guest | null => {
      const email = mailto(p.calendarAddress)
      if (!email) return null
      const status = STATUSES.includes(p.participationStatus as GuestStatus) ? (p.participationStatus as GuestStatus) : 'needs-action'
      return {
        email,
        name: p.name ?? null,
        organizer: !!p.roles?.owner,
        optional: !!p.roles?.optional,
        status,
      }
    })
    .filter((g): g is Guest => g !== null)
    .sort((a, b) => Number(b.organizer) - Number(a.organizer))
  return guests.some((g) => !g.organizer) ? guests : []
}

function toRepeat(rule: JmapRecurrenceRule | null | undefined): Repeat | null {
  if (!rule) return null
  const frequency = (['daily', 'weekly', 'monthly', 'yearly'] as const).find((f) => f === rule.frequency)
  if (!frequency) return null
  return {
    frequency,
    interval: rule.interval ?? 1,
    days: (rule.byDay ?? []).map((d) => d.day).filter((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d)),
    until: rule.until ? rule.until.slice(0, 10) : null,
    count: rule.count ?? null,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// API → Stalwart

/**
 * The JSCalendar fields for an event's time, text and repeat rule (not calendar or guests). description, location
 * and repeat are only written when given, so an update that leaves them out keeps them; '' or null clears them.
 */
export function eventFields(input: EventInput): Record<string, unknown> {
  const fields: Record<string, unknown> = { '@type': 'Event', title: input.title, ...timeFields(input) }
  if (input.description !== undefined) fields.description = input.description
  if (input.location !== undefined) {
    fields.locations = input.location ? { l: { '@type': 'Location', name: input.location } } : null
  }
  if (input.repeat !== undefined) fields.recurrenceRule = input.repeat ? fromRepeat(input.repeat) : null
  return fields
}

/** start, duration, timeZone and showWithoutTime. Throws a plain Error with a readable message on bad input. */
export function timeFields(input: Pick<EventInput, 'allDay' | 'start' | 'end' | 'timeZone'>): Record<string, unknown> {
  if (input.allDay) {
    const first = input.start.slice(0, 10)
    const last = input.end.slice(0, 10)
    const days = dayDiff(first, last) + 1
    if (days < 1) throw new Error('The event ends before it starts')
    return { start: `${first}T00:00:00`, duration: `P${days}D`, showWithoutTime: true, timeZone: null }
  }
  if (!input.timeZone) throw new Error('timeZone is required for an event with a time')
  const start = withSeconds(input.start)
  const end = withSeconds(input.end)
  const minutes = minuteDiff(start, end)
  if (minutes < 0) throw new Error('The event ends before it starts')
  return { start, duration: toDuration(minutes), timeZone: input.timeZone, showWithoutTime: false }
}

function fromRepeat(repeat: NonNullable<EventInput['repeat']>): Record<string, unknown> {
  const rule: Record<string, unknown> = { '@type': 'RecurrenceRule', frequency: repeat.frequency }
  if (repeat.interval && repeat.interval > 1) rule.interval = repeat.interval
  if (repeat.frequency === 'weekly' && repeat.days?.length) {
    rule.byDay = repeat.days.map((day) => ({ '@type': 'NDay', day }))
  }
  if (repeat.until) rule.until = `${repeat.until.slice(0, 10)}T23:59:59`
  else if (repeat.count) rule.count = repeat.count
  return rule
}

/**
 * The participants map for an event this mailbox organizes. Setting the organizer explicitly matters: under the
 * admin key Stalwart's own scheduling identity is the admin's address, but it takes the organizer from here.
 * Guests already on the event keep their entry, and so their answer.
 */
export function participants(
  organizer: { email: string; name: string | null },
  guests: NonNullable<EventInput['guests']>,
  existing: JmapEvent['participants'],
): Record<string, JmapParticipant> | null {
  const unique = new Map<string, (typeof guests)[number]>()
  for (const g of guests) {
    const email = g.email.trim().toLowerCase()
    if (email && email !== organizer.email.toLowerCase()) unique.set(email, g)
  }
  if (!unique.size) return null

  const byEmail = new Map(Object.entries(existing ?? {}).map(([key, p]) => [mailto(p.calendarAddress), { key, p }]))
  const out: Record<string, JmapParticipant> = {}
  const own = byEmail.get(organizer.email.toLowerCase())
  out[own?.key ?? 'organizer'] = {
    '@type': 'Participant',
    name: organizer.name,
    calendarAddress: `mailto:${organizer.email}`,
    roles: { owner: true, attendee: true },
    participationStatus: 'accepted',
  }
  let n = 0
  for (const [email, g] of unique) {
    const old = byEmail.get(email)
    const roles: Record<string, true> = { attendee: true }
    if (g.optional) roles.optional = true
    let key = old?.key
    while (!key || key in out) key = `g${++n}`
    out[key] = {
      '@type': 'Participant',
      name: g.name ?? old?.p.name ?? null,
      calendarAddress: `mailto:${email}`,
      roles,
      participationStatus: old?.p.participationStatus ?? 'needs-action',
      expectReply: true,
    }
  }
  return out
}

/**
 * Per-occurrence changes are keyed by each occurrence's original local start. When the series' start moves from
 * `from` to `to`, every key moves by the same amount so edited and deleted occurrences stay edited and deleted.
 * An override's own `start` (an occurrence moved on its own) is left as it is.
 */
export function rekeyOverrides(
  overrides: Record<string, Record<string, unknown>>,
  from: string,
  to: string,
): Record<string, Record<string, unknown>> {
  const shift = minuteDiff(withSeconds(from), withSeconds(to))
  if (!shift) return overrides
  return Object.fromEntries(Object.entries(overrides).map(([key, value]) => [addMinutes(key, shift), value]))
}

/** The key of this mailbox's own entry in an event's participants, for RSVP. */
export function ownParticipantKey(participantsMap: JmapEvent['participants'], addresses: string[]): string | null {
  for (const [key, p] of Object.entries(participantsMap ?? {})) {
    const email = mailto(p.calendarAddress)
    if (email && addresses.includes(email)) return key
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Dates. Local date-times are handled as plain wall-clock values (no zone): JSCalendar stores them that way.

export function mailto(address: string | null | undefined): string | null {
  if (!address) return null
  const email = address.replace(/^mailto:/i, '').trim().toLowerCase()
  return email.includes('@') ? email : null
}

/** A wall-clock time in an IANA zone as a UTC instant (…Z). Unknown zones are taken as UTC. */
export function zonedToUtc(local: string, timeZone: string): string {
  const wallMs = wall(local)
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return `${withSeconds(local)}Z`
  }
  // The zone's offset at an instant: what its clock shows then, minus the instant. Two passes settle DST edges.
  const offset = (t: number) => {
    const p = Object.fromEntries(format.formatToParts(new Date(t)).map((x) => [x.type, x.value]))
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t
  }
  let t = wallMs - offset(wallMs)
  t = wallMs - offset(t)
  return `${new Date(t).toISOString().slice(0, 19)}Z`
}

export function durationMinutes(duration: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration)
  if (!m) return 0
  const [, w, d, h, min] = m.map((v) => Number(v ?? 0))
  return ((w! * 7 + d!) * 24 + h!) * 60 + min!
}

export function toDuration(minutes: number): string {
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const time = `${hours ? `${hours}H` : ''}${mins ? `${mins}M` : ''}`
  if (!days && !time) return 'PT0S'
  return `P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`
}

function wall(local: string): number {
  return Date.parse(`${withSeconds(local)}Z`)
}

export function withSeconds(local: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(local)) return `${local}T00:00:00`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return `${local}:00`
  return local.slice(0, 19)
}

function trimSeconds(local: string): string {
  return local.slice(0, 16)
}

function minuteDiff(a: string, b: string): number {
  return Math.round((wall(b) - wall(a)) / 60000)
}

function dayDiff(a: string, b: string): number {
  return Math.round((wall(b) - wall(a)) / 86400000)
}

export function addMinutes(local: string, minutes: number): string {
  return new Date(wall(local) + minutes * 60000).toISOString().slice(0, 19)
}

export function addDays(date: string, days: number): string {
  return new Date(wall(date) + days * 86400000).toISOString().slice(0, 10)
}
