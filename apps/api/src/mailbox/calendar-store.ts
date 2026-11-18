// Calendars kept in a mailbox's store (docs/mailbox-store-plan.md, phase 3a), behind ../mailserver/calendar-backend.ts.
// Events are JSCalendar JSON in the store; series are expanded here (./calendar-expand.ts).
//
// With `notify`, a change emails the guests (or, for a guest's own answer, the organizer) (phase 3b: ./scheduling.ts decides, ./invite-send.ts sends). The change is saved first; if the email then
// fails, the caller hears so (invite_send_failed) and the event stays as saved.

import * as mailboxesDb from '../db/mailboxes'
import type { MailboxRow } from '../db/mailboxes'
import type { CalendarBackend } from '../mailserver/calendar-backend'
import { EmailError } from '../mailserver/errors'
import type { StoredCalendar, StoredEvent } from '../mailserver/calendar-types'
import type { EmailEnv } from '../mailserver/types'
import { applyPatch, changesSchedule, expand, occurrenceOf, parseOccurrenceId, timeColumns, withTimes } from './calendar-expand'
import { ulid } from './inbound'
import { sendInvites } from './invite-send'
import { scheduling } from './scheduling'
import type { StoreCalendar, StoreEventPut } from './store'
import { store } from './stub'

export async function storeCalendars(env: EmailEnv, mailbox: MailboxRow): Promise<CalendarBackend> {
  const stub = await store(env, mailbox.id)

  const rows = async (ids: string[]): Promise<StoredEvent[]> =>
    (await stub.eventRows(ids)).map((r) => ({ ...(JSON.parse(r.json) as StoredEvent), id: r.id }))
  const series = async (id: string): Promise<StoredEvent | null> => (await rows([id]))[0] ?? null
  const put = async (e: StoredEvent) => stub.putEvents([toRow(e)])
  const calendars = async (): Promise<StoredCalendar[]> => (await stub.calendarRows()).map(toCalendar)
  const own = ownAddresses(mailbox)
  const notifyGuests = async (before: StoredEvent | null, after: StoredEvent | null) => {
    const emails = scheduling(before, after, own)
    if (!emails.length) return
    try {
      await sendInvites(env, mailbox, emails, own)
    } catch (err) {
      console.error(`calendar: invitation email from ${mailbox.id} failed`, err)
      throw new EmailError('invite_send_failed', `Saved, but emailing the guests failed: ${err instanceof Error ? err.message : String(err)}`, 502)
    }
  }

  const backend: CalendarBackend = {
    kind: 'store',
    getCalendars: calendars,
    async setUp() {
      const existing = await calendars()
      if (existing.length) return existing
      await stub.setCalendarRows([
        { id: ulid(), name: 'Work', color: null, isDefault: true, sortOrder: 0 },
        { id: ulid(), name: 'Personal', color: null, isDefault: false, sortOrder: 1 },
      ])
      return calendars()
    },
    async queryEvents(range) {
      const after = Date.parse(range.after)
      const before = Date.parse(range.before)
      const found = (await stub.eventsInRange(range.after, range.before, range.calendarId ?? null)).map((r) => ({
        ...(JSON.parse(r.json) as StoredEvent),
        id: r.id,
      }))
      return found.flatMap((e) => expand(e, after, before)).sort((a, b) => a.utcStart!.localeCompare(b.utcStart!))
    },
    async getRecurrenceRules(ids) {
      return new Map((await rows(ids)).map((e) => [e.id, e.recurrenceRule ?? null]))
    },
    findByUid: (uid) => stub.eventByUid(uid),
    async getEvent(id) {
      const occurrence = parseOccurrenceId(id)
      if (occurrence) {
        const base = await series(occurrence.seriesId)
        return base?.recurrenceRule ? occurrenceOf(base, occurrence.recurrenceId) : null
      }
      const e = await series(id)
      return e ? withTimes(e) : null
    },
    async createEvent(event, notify) {
      const calendarId = Object.keys((event.calendarIds as Record<string, true> | undefined) ?? {})[0]
      if (!calendarId || !(await calendars()).some((c) => c.id === calendarId)) {
        throw new EmailError('calendar_not_found', 'That calendar does not exist', 404)
      }
      const id = ulid()
      const now = new Date().toISOString()
      const created = { uid: crypto.randomUUID(), sequence: 0, ...event, id, created: now, updated: now } as unknown as StoredEvent
      await put(created)
      if (notify) await notifyGuests(null, created)
      return id
    },
    async updateEvent(id, patch, notify) {
      // A change addressed to one occurrence applies to its series, as the calls in ../mailserver/calendar.ts expect.
      const current = await series(parseOccurrenceId(id)?.seriesId ?? id)
      if (!current) throw new EmailError('event_not_found', 'That event no longer exists', 404)
      const next = applyPatch(current as unknown as Record<string, unknown>, patch) as unknown as StoredEvent
      // An organizer's own sequence (an update received by email) is kept as it is; our own changes raise it.
      if (changesSchedule(patch) && !('sequence' in patch)) next.sequence = (current.sequence ?? 0) + 1
      next.updated = new Date().toISOString()
      await put(next)
      if (notify) await notifyGuests(current, next)
    },
    async destroyEvent(id, notify) {
      const occurrence = parseOccurrenceId(id)
      if (!occurrence) {
        const before = notify ? await series(id) : null
        await stub.deleteEvent(id)
        if (before) await notifyGuests(before, null)
        return
      }
      // One occurrence: left out of its series from now on.
      const base = await series(occurrence.seriesId)
      if (!base) return
      const next = { ...base, recurrenceOverrides: { ...(base.recurrenceOverrides ?? {}), [occurrence.recurrenceId]: { excluded: true } }, sequence: (base.sequence ?? 0) + 1 }
      await put(next)
      if (notify) await notifyGuests(base, next)
    },
    async createCalendar(name) {
      const existing = await stub.calendarRows()
      const id = ulid()
      const sortOrder = existing.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1
      await stub.setCalendarRows([{ id, name, color: null, isDefault: !existing.length, sortOrder }])
      return id
    },
    async importEvents(events) {
      const calendarIds = new Set((await calendars()).map((c) => c.id))
      const now = new Date().toISOString()
      const created: Record<string, string> = {}
      const failed: Record<string, string> = {}
      const rows: StoreEventPut[] = []
      for (const [key, event] of Object.entries(events)) {
        const calendarId = Object.keys((event.calendarIds as Record<string, true> | undefined) ?? {})[0]
        if (!calendarId || !calendarIds.has(calendarId)) {
          failed[key] = 'calendar not found'
          continue
        }
        const id = ulid()
        try {
          rows.push(toRow({ uid: crypto.randomUUID(), sequence: 0, ...event, id, created: now, updated: now } as unknown as StoredEvent))
          created[key] = id
        } catch (err) {
          // A date or repeat rule we can't place in time: this event only.
          failed[key] = err instanceof Error ? err.message.slice(0, 200) : String(err)
        }
      }
      for (let i = 0; i < rows.length; i += 200) await stub.putEvents(rows.slice(i, i + 200))
      return { created, failed }
    },
  }
  return backend
}

/** The store row for an event: its JSON without the fields only an expanded entry has, plus where it sits in time. */
function toRow(e: StoredEvent): StoreEventPut {
  const { utcStart: _s, utcEnd: _e, baseEventId: _b, recurrenceId: _r, ...event } = e
  const time = timeColumns(event as StoredEvent)
  return {
    id: e.id,
    calendarId: Object.keys(e.calendarIds ?? {})[0] ?? '',
    uid: e.uid ?? null,
    json: JSON.stringify(event),
    startUtc: time.startUtc,
    endUtc: time.endUtc,
    recurring: time.recurring,
  }
}

/** The mailbox's own addresses, lowercase: its address and aliases. */
export function ownAddresses(mailbox: MailboxRow): string[] {
  let aliases: string[] = []
  try {
    aliases = JSON.parse(mailbox.aliases ?? '[]') as string[]
  } catch {
    // A malformed list just means no aliases.
  }
  return [mailbox.address, ...aliases].map((a) => a.toLowerCase())
}

function toCalendar(c: StoreCalendar): StoredCalendar {
  return { id: c.id, name: c.name, isDefault: c.isDefault, color: c.color, sortOrder: c.sortOrder }
}
