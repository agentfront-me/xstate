// JMAP Calendars against any Stalwart account, with the admin key acting as that account (`accountId` = the
// mailbox's stalwart_id), the same way ./mail does. Stalwart 1.0 stores events as JSCalendar 2.0: the repeat rule is
// `recurrenceRule` (singular) and fields it doesn't know are dropped without an error. See docs/calendar-plan.md.

import { EmailError } from '../errors'
import { jmap, type StalwartEnv } from './client'

export const CALENDAR_CAPABILITIES = [
  'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:calendars',
  'urn:ietf:params:jmap:calendars:parse',
  'urn:ietf:params:jmap:principals',
]

type Args = Record<string, unknown>
type SetError = { type?: string; description?: string; properties?: string[] }

export type JmapCalendar = { id: string; name: string; isDefault: boolean; color: string | null; sortOrder: number }

export type JmapParticipant = {
  '@type'?: 'Participant'
  name?: string | null
  calendarAddress?: string
  roles?: Record<string, true>
  participationStatus?: string
  expectReply?: boolean
}

export type JmapRecurrenceRule = {
  '@type'?: 'RecurrenceRule'
  frequency: string
  interval?: number
  byDay?: { '@type'?: 'NDay'; day: string }[]
  until?: string
  count?: number
}

/** The JSCalendar fields we read and write. Everything else on an event is left alone. */
export type JmapEvent = {
  id: string
  calendarIds: Record<string, true>
  /** confirmed, tentative or cancelled. A cancelled invitation stays in the guest's calendar with this status. */
  status?: string
  /** Bumped by the organizer on every change; a newer invite email has a higher one. */
  sequence?: number
  uid?: string
  title?: string
  description?: string | null
  start: string
  duration?: string
  timeZone?: string | null
  showWithoutTime?: boolean
  locations?: Record<string, { '@type'?: 'Location'; name?: string }> | null
  participants?: Record<string, JmapParticipant> | null
  recurrenceRule?: JmapRecurrenceRule | null
  recurrenceOverrides?: Record<string, Args> | null
  organizerCalendarAddress?: string | null
  /** Set on occurrences returned by an expanded query. */
  baseEventId?: string | null
  recurrenceId?: string | null
  utcStart?: string
  utcEnd?: string
  updated?: string
}

/**
 * Stalwart refuses `recurrenceOverrides` together with `utcStart`/`utcEnd` in one get ("cannot be requested
 * together"), so lists ask for the UTC times and a single event is read twice in one request and merged.
 */
const BASE_PROPERTIES = [
  'calendarIds',
  'status',
  'sequence',
  'uid',
  'title',
  'description',
  'start',
  'duration',
  'timeZone',
  'showWithoutTime',
  'locations',
  'participants',
  'recurrenceRule',
  'organizerCalendarAddress',
  'baseEventId',
  'recurrenceId',
  'updated',
]
const LIST_PROPERTIES = [...BASE_PROPERTIES, 'utcStart', 'utcEnd']

function calendar(env: StalwartEnv, calls: [string, Args][]) {
  return jmap(env, calls, CALENDAR_CAPABILITIES)
}

export async function getCalendars(env: StalwartEnv, accountId: string): Promise<JmapCalendar[]> {
  const [result] = await calendar(env, [
    ['Calendar/get', { accountId, properties: ['name', 'isDefault', 'color', 'sortOrder'] }],
  ])
  return (result?.list as JmapCalendar[] | undefined) ?? []
}

export async function setCalendars(
  env: StalwartEnv,
  accountId: string,
  change: { create?: Record<string, Args>; update?: Record<string, Args> },
): Promise<void> {
  const [result] = await calendar(env, [['Calendar/set', { accountId, ...change }]])
  const failed = { ...(result?.notCreated as object), ...(result?.notUpdated as object) } as Record<string, SetError>
  const error = Object.values(failed)[0]
  if (error) throw setError(error)
}

/**
 * Events overlapping [after, before) (UTC), with repeating events expanded into one entry per occurrence,
 * sorted by start.
 */
export async function queryEvents(
  env: StalwartEnv,
  accountId: string,
  range: { after: string; before: string; calendarId?: string },
): Promise<JmapEvent[]> {
  const filter: Args = { after: range.after, before: range.before }
  if (range.calendarId) filter.inCalendar = range.calendarId
  const [, got] = await calendar(env, [
    [
      'CalendarEvent/query',
      { accountId, filter, expandRecurrences: true, sort: [{ property: 'start', isAscending: true }] },
    ],
    [
      'CalendarEvent/get',
      {
        accountId,
        '#ids': { resultOf: 'c0', name: 'CalendarEvent/query', path: '/ids' },
        properties: LIST_PROPERTIES,
      },
    ],
  ])
  return (got?.list as JmapEvent[] | undefined) ?? []
}

/** The repeat rules of these events (series), by id. Expanded occurrences don't carry their series' rule. */
export async function getRecurrenceRules(
  env: StalwartEnv,
  accountId: string,
  ids: string[],
): Promise<Map<string, JmapRecurrenceRule | null>> {
  if (!ids.length) return new Map()
  const [result] = await calendar(env, [['CalendarEvent/get', { accountId, ids, properties: ['recurrenceRule'] }]])
  const list = (result?.list as Pick<JmapEvent, 'id' | 'recurrenceRule'>[] | undefined) ?? []
  return new Map(list.map((e) => [e.id, e.recurrenceRule ?? null]))
}

/** A parsed invite email part: the event(s) it carries and the iTIP method (request, reply, cancel, …). */
export type ParsedInvite = JmapEvent & { method?: string | null; iCalendar?: unknown; isOrigin?: unknown; isDraft?: unknown }

/** Reads the events in an email's text/calendar part (a blob in this account). Empty when it isn't one. */
export async function parseInvite(env: StalwartEnv, accountId: string, blobId: string): Promise<ParsedInvite[]> {
  const [result] = await calendar(env, [['CalendarEvent/parse', { accountId, blobIds: [blobId] }]])
  const parsed = (result?.parsed as Record<string, ParsedInvite[] | null> | undefined)?.[blobId]
  return parsed ?? []
}

/** The id of the event with this iCalendar UID in the account, or null. */
export async function findByUid(env: StalwartEnv, accountId: string, uid: string): Promise<string | null> {
  const [result] = await calendar(env, [['CalendarEvent/query', { accountId, filter: { uid } }]])
  return ((result?.ids as string[] | undefined) ?? [])[0] ?? null
}

/** One event with everything we use: its UTC times and its per-occurrence changes. */
export async function getEvent(env: StalwartEnv, accountId: string, id: string): Promise<JmapEvent | null> {
  const [times, overrides] = await calendar(env, [
    ['CalendarEvent/get', { accountId, ids: [id], properties: LIST_PROPERTIES }],
    ['CalendarEvent/get', { accountId, ids: [id], properties: ['recurrenceOverrides'] }],
  ])
  const event = ((times?.list as JmapEvent[] | undefined) ?? [])[0]
  if (!event) return null
  const extra = ((overrides?.list as Pick<JmapEvent, 'recurrenceOverrides'>[] | undefined) ?? [])[0]
  return { ...event, recurrenceOverrides: extra?.recurrenceOverrides ?? null }
}

/**
 * Creates, updates or destroys one event. With `notify`, Stalwart sends invitations, updates and cancellations to
 * the guests by email (iMIP) and files them straight into calendars of other accounts on this server.
 */
export async function createEvent(env: StalwartEnv, accountId: string, event: Args, notify: boolean): Promise<string> {
  const [result] = await calendar(env, [
    ['CalendarEvent/set', { accountId, sendSchedulingMessages: notify, create: { e: event } }],
  ])
  const created = (result?.created as Record<string, { id: string }> | undefined)?.e
  if (!created) throw setError((result?.notCreated as Record<string, SetError> | undefined)?.e)
  return created.id
}

/**
 * Creates several events at once without any scheduling messages (imports). Returns the new ids by key, and the
 * reason for each one Stalwart refused.
 */
export async function importEvents(
  env: StalwartEnv,
  accountId: string,
  events: Record<string, Args>,
): Promise<{ created: Record<string, string>; failed: Record<string, string> }> {
  if (!Object.keys(events).length) return { created: {}, failed: {} }
  const [result] = await calendar(env, [['CalendarEvent/set', { accountId, sendSchedulingMessages: false, create: events }]])
  const created = Object.fromEntries(Object.entries((result?.created as Record<string, { id: string }> | undefined) ?? {}).map(([k, v]) => [k, v.id]))
  const failed = Object.fromEntries(
    Object.entries((result?.notCreated as Record<string, SetError> | undefined) ?? {}).map(([k, e]) => [k, `${e.description ?? e.type ?? 'refused'}${e.properties?.length ? ` (${e.properties.join(', ')})` : ''}`]),
  )
  return { created, failed }
}

/** Makes a calendar and returns its id. */
export async function createCalendar(env: StalwartEnv, accountId: string, name: string): Promise<string> {
  const [result] = await calendar(env, [['Calendar/set', { accountId, create: { c: { name } } }]])
  const id = (result?.created as Record<string, { id: string }> | undefined)?.c?.id
  if (!id) throw setError((result?.notCreated as Record<string, SetError> | undefined)?.c)
  return id
}

export async function updateEvent(env: StalwartEnv, accountId: string, id: string, patch: Args, notify: boolean) {
  const [result] = await calendar(env, [
    ['CalendarEvent/set', { accountId, sendSchedulingMessages: notify, update: { [id]: patch } }],
  ])
  const failed = (result?.notUpdated as Record<string, SetError> | undefined)?.[id]
  if (failed || !(id in ((result?.updated as object | undefined) ?? {}))) throw setError(failed)
}

export async function destroyEvent(env: StalwartEnv, accountId: string, id: string, notify: boolean): Promise<void> {
  const [result] = await calendar(env, [
    ['CalendarEvent/set', { accountId, sendSchedulingMessages: notify, destroy: [id] }],
  ])
  const failed = (result?.notDestroyed as Record<string, SetError> | undefined)?.[id]
  // Already gone is fine: the goal is that it doesn't exist.
  if (failed && failed.type !== 'notFound') throw setError(failed)
}

function setError(error: SetError | undefined): EmailError {
  const detail = `${error?.description ?? error?.type ?? 'unknown error'}${error?.properties?.length ? ` (${error.properties.join(', ')})` : ''}`
  if (error?.type === 'notFound') return new EmailError('event_not_found', 'That event no longer exists', 404)
  if (error?.type === 'invalidProperties') return new EmailError('invalid', `The calendar server rejected the event: ${detail}`, 400)
  if (error?.type === 'forbidden') return new EmailError('forbidden', detail, 403)
  return new EmailError('mail_server_error', `The calendar server rejected the change: ${detail}`, 502)
}
