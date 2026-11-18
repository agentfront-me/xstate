// The calendar shapes a mailbox store keeps and the apps read: JSCalendar 2.0 (RFC 8984) events, with the repeat
// rule as `recurrenceRule` (singular). See docs/calendar-plan.md. Types only, so the Node tests can import it.

export type StoredCalendar = { id: string; name: string; isDefault: boolean; color: string | null; sortOrder: number }

export type StoredParticipant = {
  '@type'?: 'Participant'
  name?: string | null
  calendarAddress?: string
  roles?: Record<string, true>
  participationStatus?: string
  expectReply?: boolean
}

export type StoredRecurrenceRule = {
  '@type'?: 'RecurrenceRule'
  frequency: string
  interval?: number
  byDay?: { '@type'?: 'NDay'; day: string }[]
  until?: string
  count?: number
}

/** The JSCalendar fields we read and write. Everything else on an event is left alone. */
export type StoredEvent = {
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
  participants?: Record<string, StoredParticipant> | null
  recurrenceRule?: StoredRecurrenceRule | null
  recurrenceOverrides?: Record<string, Record<string, unknown>> | null
  organizerCalendarAddress?: string | null
  /** Set on occurrences of an expanded list. */
  baseEventId?: string | null
  recurrenceId?: string | null
  utcStart?: string
  utcEnd?: string
  updated?: string
}

/** A parsed invite email part: the event(s) it carries and the iTIP method (request, reply, cancel, …). */
export type ParsedInvite = StoredEvent & { method?: string | null; iCalendar?: unknown; isOrigin?: unknown; isDraft?: unknown }
