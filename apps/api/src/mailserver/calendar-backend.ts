// Where a mailbox's calendars live: Stalwart (JMAP Calendars) for mailboxes on Stalwart, the mailbox's own store for
// mailboxes whose mail the store holds (docs/mailbox-store-plan.md, phase 3: calendars move with the mail). Both
// speak JSCalendar and the same calls, so ./calendar.ts doesn't care which one it has.

import type { MailboxRow } from '../db/mailboxes'
import { storeCalendars } from '../mailbox/calendar-store'
import * as jmap from './stalwart/calendar'
import type { JmapCalendar, JmapEvent, JmapRecurrenceRule } from './stalwart/calendar'
import type { EmailEnv } from './types'

export type CalendarBackend = {
  kind: 'stalwart' | 'store'
  getCalendars(): Promise<JmapCalendar[]>
  /** The calendars, set up the first time: "Work" (the default) and "Personal". */
  setUp(): Promise<JmapCalendar[]>
  /** Events overlapping [after, before) (UTC), series expanded into occurrences, sorted by start. */
  queryEvents(range: { after: string; before: string; calendarId?: string }): Promise<JmapEvent[]>
  getRecurrenceRules(ids: string[]): Promise<Map<string, JmapRecurrenceRule | null>>
  findByUid(uid: string): Promise<string | null>
  getEvent(id: string): Promise<JmapEvent | null>
  /** With `notify`, guests are emailed (by Stalwart, or through SES for the store: mailbox/scheduling.ts). */
  createEvent(event: Record<string, unknown>, notify: boolean): Promise<string>
  updateEvent(id: string, patch: Record<string, unknown>, notify: boolean): Promise<void>
  destroyEvent(id: string, notify: boolean): Promise<void>
  /** Makes a calendar (imports: one per Google calendar). Returns its id. */
  createCalendar(name: string): Promise<string>
  /**
   * Creates several events at once without emailing anyone (imports). Returns the new ids by key, and the reason
   * for each one refused; one bad event never fails the others.
   */
  importEvents(events: Record<string, Record<string, unknown>>): Promise<{ created: Record<string, string>; failed: Record<string, string> }>
}

/** The name Stalwart gives the calendar it creates with every account. */
export const STALWART_DEFAULT = /^Stalwart Calendar\b/

export async function calendarsOf(env: EmailEnv, mailbox: MailboxRow): Promise<CalendarBackend> {
  return mailbox.backend === 'store' ? storeCalendars(env, mailbox) : stalwartCalendars(env, mailbox.stalwart_id)
}

export function stalwartCalendars(env: EmailEnv, accountId: string): CalendarBackend {
  return {
    kind: 'stalwart',
    getCalendars: () => jmap.getCalendars(env, accountId),
    setUp: () => setUpCalendars(env, accountId),
    queryEvents: (range) => jmap.queryEvents(env, accountId, range),
    getRecurrenceRules: (ids) => jmap.getRecurrenceRules(env, accountId, ids),
    findByUid: (uid) => jmap.findByUid(env, accountId, uid),
    getEvent: (id) => jmap.getEvent(env, accountId, id),
    createEvent: (event, notify) => jmap.createEvent(env, accountId, event, notify),
    updateEvent: (id, patch, notify) => jmap.updateEvent(env, accountId, id, patch, notify),
    destroyEvent: (id, notify) => jmap.destroyEvent(env, accountId, id, notify),
    createCalendar: (name) => jmap.createCalendar(env, accountId, name),
    importEvents: (events) => jmap.importEvents(env, accountId, events),
  }
}

/**
 * A Stalwart account's calendars, set up the first time: Stalwart's automatic calendar is renamed "Work" and a
 * "Personal" one added. Also used by the Google import before it copies into the default calendar.
 */
export async function setUpCalendars(env: EmailEnv, accountId: string): Promise<JmapCalendar[]> {
  const calendars = await jmap.getCalendars(env, accountId)
  if (calendars.length !== 1 || !STALWART_DEFAULT.test(calendars[0]!.name)) return calendars
  await jmap.setCalendars(env, accountId, {
    update: { [calendars[0]!.id]: { name: 'Work' } },
    create: { personal: { name: 'Personal', sortOrder: 1 } },
  })
  return jmap.getCalendars(env, accountId)
}
