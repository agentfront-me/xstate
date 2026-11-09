// Where the Calendar page gets its data. Two sources with the same shape, like mail (../mail/source.ts):
// - live: the calendar_* API (apps/api/src/operations/calendar.ts) for one mailbox's calendar
// - demo: sample events in memory, at /app/?demo
// Shapes match apps/api/src/mailserver/calendar-events.ts.

import { api } from '../lib/core'

export type Calendar = { id: string; name: string; isDefault: boolean; color: string | null }

export type GuestStatus = 'needs-action' | 'accepted' | 'declined' | 'tentative'
export type Guest = { email: string; name: string | null; organizer: boolean; optional: boolean; status: GuestStatus }
export type Weekday = 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su'
export type Repeat = {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  days: Weekday[]
  until: string | null
  count: number | null
}

export type CalendarEvent = {
  id: string
  seriesId: string | null
  occurrence: string | null
  calendarId: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  title: string
  description: string
  location: string
  allDay: boolean
  /** UTC instants for timed events; dates (end exclusive) for all-day ones. */
  start: string
  end: string
  /** As entered, in timeZone. All-day: dates, end inclusive. */
  localStart: string
  localEnd: string
  timeZone: string | null
  repeat: Repeat | null
  guests: Guest[]
  organizer: string | null
  isOrganizer: boolean
  myStatus: GuestStatus | null
  updatedAt: string | null
}

export type EventInput = {
  calendarId?: string
  title: string
  description?: string
  location?: string
  allDay: boolean
  start: string
  end: string
  timeZone?: string
  repeat?: { frequency: Repeat['frequency']; interval?: number; days?: Weekday[]; until?: string | null } | null
  guests?: { email: string; name?: string | null }[]
  /** false: save without emailing guests (invites, updates). */
  notify?: boolean
}

export type Scope = 'series' | 'occurrence'

export type CalendarSource = {
  calendars(): Promise<Calendar[]>
  events(from: string, to: string): Promise<CalendarEvent[]>
  get(id: string): Promise<CalendarEvent>
  create(input: EventInput): Promise<CalendarEvent>
  update(event: CalendarEvent, input: EventInput, scope: Scope): Promise<CalendarEvent>
  remove(event: CalendarEvent, scope: Scope): Promise<void>
  respond(event: CalendarEvent, status: Exclude<GuestStatus, 'needs-action'>): Promise<CalendarEvent>
}

/** The id that edits the whole event: the series for an occurrence, else the event itself. */
export const seriesIdOf = (e: CalendarEvent) => e.seriesId ?? e.id

export function liveSource(mailboxId: string): CalendarSource {
  const base = `/calendar/mailboxes/${mailboxId}`
  return {
    calendars: async () => (await api<{ calendars: Calendar[] }>('GET', `${base}/calendars`)).calendars,
    events: async (from, to) =>
      (await api<{ events: CalendarEvent[] }>('GET', `${base}/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).events,
    get: async (id) => (await api<{ event: CalendarEvent }>('GET', `${base}/events/${id}`)).event,
    create: async (input) => (await api<{ event: CalendarEvent }>('POST', `${base}/events`, input)).event,
    update: async (event, input, scope) =>
      (
        await api<{ event: CalendarEvent }>('PATCH', `${base}/events/${seriesIdOf(event)}`, {
          ...input,
          scope,
          ...(scope === 'occurrence' && { occurrence: event.occurrence }),
        })
      ).event,
    remove: async (event, scope) => {
      const occurrence = scope === 'occurrence' && event.occurrence ? `?occurrence=${encodeURIComponent(event.occurrence)}` : ''
      await api('DELETE', `${base}/events/${seriesIdOf(event)}${occurrence}`)
    },
    respond: async (event, status) =>
      (await api<{ event: CalendarEvent }>('POST', `${base}/events/${seriesIdOf(event)}/rsvp`, { status })).event,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Demo: a week like the design's, around today. Kept in memory; repeating events aren't expanded.

const DEMO_CALENDARS: Calendar[] = [
  { id: 'work', name: 'Work', isDefault: true, color: null },
  { id: 'personal', name: 'Personal', isDefault: false, color: null },
]

let demoEvents: CalendarEvent[] | null = null

function demoSeed(): CalendarEvent[] {
  const today = localDate(new Date())
  const at = (day: number, time: string) => `${addDays(today, day)}T${time}`
  const me = { email: 'you@xstate.com', name: 'You', organizer: true, optional: false, status: 'accepted' as const }
  const make = (id: string, calendarId: string, title: string, start: string, end: string, extra: Partial<CalendarEvent> = {}) =>
    demoEvent({ id, calendarId, title, localStart: start, localEnd: end, allDay: false, ...extra })
  return [
    make('d1', 'work', 'Team standup', at(0, '09:00'), at(0, '09:30')),
    make('d2', 'work', 'Onboarding: Okafor Retail', at(0, '11:00'), at(0, '12:00'), { location: 'Video call' }),
    make('d3', 'personal', 'Gym', at(0, '18:00'), at(0, '19:00')),
    make('d4', 'work', 'Pricing review', at(1, '10:00'), at(1, '11:00'), {
      location: 'Room 2',
      description: 'Q1 wholesale tiers.',
      guests: [
        me,
        { email: 'emma@xstate.com', name: 'Emma Wright', organizer: false, optional: false, status: 'accepted' },
        { email: 'lucas@xstate.com', name: 'Lucas Meyer', organizer: false, optional: false, status: 'needs-action' },
      ],
      organizer: me.email,
    }),
    make('d5', 'work', 'Call: Maria Lopez', at(2, '15:00'), at(2, '15:30'), {
      guests: [
        { email: 'maria@lopez.studio', name: 'Maria Lopez', organizer: true, optional: false, status: 'accepted' },
        { ...me, organizer: false, status: 'needs-action' },
      ],
      organizer: 'maria@lopez.studio',
      isOrganizer: false,
      myStatus: 'needs-action',
    }),
    make('d6', 'work', 'Winter drop planning', at(3, '13:00'), at(3, '14:30')),
    demoEvent({ id: 'd7', calendarId: 'personal', title: 'Day off', allDay: true, localStart: addDays(today, 4), localEnd: addDays(today, 4) }),
  ]
}

function demoEvent(e: Partial<CalendarEvent> & Pick<CalendarEvent, 'id' | 'calendarId' | 'title' | 'localStart' | 'localEnd' | 'allDay'>): CalendarEvent {
  const timeZone = e.allDay ? null : localZone()
  return {
    seriesId: null,
    occurrence: null,
    status: 'confirmed',
    description: '',
    location: '',
    repeat: null,
    guests: [],
    organizer: null,
    isOrganizer: true,
    myStatus: null,
    updatedAt: null,
    ...e,
    timeZone,
    start: e.allDay ? e.localStart : new Date(e.localStart).toISOString(),
    end: e.allDay ? addDays(e.localEnd, 1) : new Date(e.localEnd).toISOString(),
  }
}

function fromInput(id: string, input: EventInput, before?: CalendarEvent): CalendarEvent {
  return demoEvent({
    ...before,
    id,
    calendarId: input.calendarId ?? before?.calendarId ?? 'work',
    title: input.title,
    description: input.description ?? before?.description ?? '',
    location: input.location ?? before?.location ?? '',
    allDay: input.allDay,
    localStart: input.start,
    localEnd: input.end,
    repeat: input.repeat ? { interval: 1, days: [], until: null, count: null, ...input.repeat } : input.repeat === null ? null : (before?.repeat ?? null),
  })
}

export function demoSource(): CalendarSource {
  const all = () => (demoEvents ??= demoSeed())
  return {
    calendars: async () => DEMO_CALENDARS,
    events: async (from, to) => all().filter((e) => instant(e.end) > Date.parse(from) && instant(e.start) < Date.parse(to)),
    get: async (id) => {
      const event = all().find((e) => e.id === id)
      if (!event) throw new Error('That event no longer exists')
      return event
    },
    create: async (input) => {
      const event = fromInput(`d${Date.now()}`, input)
      demoEvents = [...all(), event]
      return event
    },
    update: async (event, input) => {
      const next = fromInput(event.id, input, event)
      demoEvents = all().map((e) => (e.id === event.id ? next : e))
      return next
    },
    remove: async (event) => {
      demoEvents = all().filter((e) => e.id !== event.id)
    },
    respond: async (event, status) => {
      const next = { ...event, myStatus: status }
      demoEvents = all().map((e) => (e.id === event.id ? next : e))
      return next
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Dates. "Local" values are wall-clock strings (YYYY-MM-DD, YYYY-MM-DDTHH:mm) in the browser's zone.

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

const pad = (n: number) => String(n).padStart(2, '0')

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function localDateTime(d: Date): string {
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return localDate(new Date(y!, m! - 1, d! + days))
}

/** Milliseconds for an event bound: a UTC instant, or a date taken as local midnight. */
export function instant(value: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number)
    return new Date(y!, m! - 1, d!).getTime()
  }
  return Date.parse(value)
}
