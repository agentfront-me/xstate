// A mailbox's calendars, kept in its own store as JSCalendar (docs/mailbox-store-plan.md, phase 3). ./calendar.ts and
// the Google Workspace import use this interface.

import type { MailboxRow } from '../db/mailboxes'
import { storeCalendars } from '../mailbox/calendar-store'
import type { StoredCalendar, StoredEvent, StoredRecurrenceRule } from './calendar-types'
import type { EmailEnv } from './types'

export type CalendarBackend = {
  kind: 'store'
  getCalendars(): Promise<StoredCalendar[]>
  /** The calendars, set up the first time: "Work" (the default) and "Personal". */
  setUp(): Promise<StoredCalendar[]>
  /** Events overlapping [after, before) (UTC), series expanded into occurrences, sorted by start. */
  queryEvents(range: { after: string; before: string; calendarId?: string }): Promise<StoredEvent[]>
  getRecurrenceRules(ids: string[]): Promise<Map<string, StoredRecurrenceRule | null>>
  findByUid(uid: string): Promise<string | null>
  getEvent(id: string): Promise<StoredEvent | null>
  /** With `notify`, guests are emailed through SES (mailbox/scheduling.ts). */
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

export async function calendarsOf(env: EmailEnv, mailbox: MailboxRow): Promise<CalendarBackend> {
  return storeCalendars(env, mailbox)
}
