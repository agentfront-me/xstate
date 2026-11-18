// Calendars kept in a mailbox's store (docs/mailbox-store-plan.md, phase 3a), behind the same calls as Stalwart's
// (../mailserver/calendar-backend.ts). Events are JSCalendar JSON in the store; series are expanded here
// (./calendar-expand.ts). The first time a store-held mailbox's calendar is used, what Stalwart holds for it is
// copied over once, ids and all, so links keep working.
//
// Invitations aren't sent from here yet (phase 3b): ../mailserver/calendar.ts refuses a change that would email
// guests before it reaches this code.

import * as mailboxesDb from '../db/mailboxes'
import type { MailboxRow } from '../db/mailboxes'
import { STALWART_DEFAULT, type CalendarBackend } from '../mailserver/calendar-backend'
import { EmailError } from '../mailserver/errors'
import * as jmap from '../mailserver/stalwart/calendar'
import type { JmapCalendar, JmapEvent } from '../mailserver/stalwart/calendar'
import type { EmailEnv } from '../mailserver/types'
import { applyPatch, changesSchedule, expand, occurrenceOf, parseOccurrenceId, timeColumns, withTimes } from './calendar-expand'
import { ulid } from './inbound'
import type { StoreCalendar, StoreEventPut } from './store'
import { store } from './stub'

/** Mailboxes whose copy from Stalwart is known to be done, so most calls skip asking. */
const copied = new Set<string>()

export async function storeCalendars(env: EmailEnv, mailbox: MailboxRow): Promise<CalendarBackend> {
  await ensureCopied(env, mailbox)
  const stub = await store(env, mailbox.id)

  const rows = async (ids: string[]): Promise<JmapEvent[]> =>
    (await stub.eventRows(ids)).map((r) => ({ ...(JSON.parse(r.json) as JmapEvent), id: r.id }))
  const series = async (id: string): Promise<JmapEvent | null> => (await rows([id]))[0] ?? null
  const put = async (e: JmapEvent) => stub.putEvents([toRow(e)])
  const calendars = async (): Promise<JmapCalendar[]> => (await stub.calendarRows()).map(toCalendar)

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
        ...(JSON.parse(r.json) as JmapEvent),
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
    async createEvent(event) {
      const calendarId = Object.keys((event.calendarIds as Record<string, true> | undefined) ?? {})[0]
      if (!calendarId || !(await calendars()).some((c) => c.id === calendarId)) {
        throw new EmailError('calendar_not_found', 'That calendar does not exist', 404)
      }
      const id = ulid()
      const now = new Date().toISOString()
      await put({ uid: crypto.randomUUID(), sequence: 0, ...event, id, created: now, updated: now } as unknown as JmapEvent)
      return id
    },
    async updateEvent(id, patch) {
      // A change addressed to one occurrence applies to its series, as the calls in ../mailserver/calendar.ts expect.
      const current = await series(parseOccurrenceId(id)?.seriesId ?? id)
      if (!current) throw new EmailError('event_not_found', 'That event no longer exists', 404)
      const next = applyPatch(current as unknown as Record<string, unknown>, patch) as unknown as JmapEvent
      if (changesSchedule(patch)) next.sequence = (current.sequence ?? 0) + 1
      next.updated = new Date().toISOString()
      await put(next)
    },
    async destroyEvent(id) {
      const occurrence = parseOccurrenceId(id)
      if (!occurrence) {
        await stub.deleteEvent(id)
        return
      }
      // One occurrence: left out of its series from now on.
      const base = await series(occurrence.seriesId)
      if (!base) return
      await put({ ...base, recurrenceOverrides: { ...(base.recurrenceOverrides ?? {}), [occurrence.recurrenceId]: { excluded: true } } })
    },
  }
  return backend
}

/** The store row for an event: its JSON without the fields only an expanded entry has, plus where it sits in time. */
function toRow(e: JmapEvent): StoreEventPut {
  const { utcStart: _s, utcEnd: _e, baseEventId: _b, recurrenceId: _r, ...event } = e
  const time = timeColumns(event as JmapEvent)
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

function toCalendar(c: StoreCalendar): JmapCalendar {
  return { id: c.id, name: c.name, isDefault: c.isDefault, color: c.color, sortOrder: c.sortOrder }
}

/**
 * Copies the mailbox's calendars from Stalwart into its store, once. Stalwart's untouched default calendar becomes
 * "Work", with a "Personal" one added, as the first look at a Stalwart calendar does. Throws calendar_busy while
 * another request is copying.
 */
export async function ensureCopied(env: EmailEnv, mailbox: MailboxRow): Promise<{ calendars: number; events: number } | null> {
  if (copied.has(mailbox.id)) return null
  const stub = await store(env, mailbox.id)
  const claim = await stub.calendarCopy('claim')
  if (claim === 'done') {
    copied.add(mailbox.id)
    return null
  }
  if (claim === 'busy') throw new EmailError('calendar_busy', 'This calendar is being set up. Try again in a moment.', 503)

  const accountId = mailbox.stalwart_id
  const calendars = accountId ? await jmap.getCalendars(env, accountId) : []
  const events = accountId ? await jmap.allEvents(env, accountId) : []
  const untouched = calendars.length === 1 && STALWART_DEFAULT.test(calendars[0]!.name)
  const rows: StoreCalendar[] = calendars.map((c, i) => ({
    id: c.id,
    name: untouched ? 'Work' : c.name,
    color: c.color ?? null,
    isDefault: c.isDefault || (!calendars.some((x) => x.isDefault) && i === 0),
    sortOrder: c.sortOrder ?? i,
  }))
  if (untouched) rows.push({ id: ulid(), name: 'Personal', color: null, isDefault: false, sortOrder: 1 })
  if (rows.length) await stub.setCalendarRows(rows)
  for (let i = 0; i < events.length; i += 200) await stub.putEvents(events.slice(i, i + 200).map(toRow))
  const counts = await stub.calendarCounts()
  if (counts.events !== events.length) {
    throw new Error(`calendar copy for ${mailbox.id}: Stalwart has ${events.length} events, the store ${counts.events}`)
  }
  await stub.calendarCopy('done')
  copied.add(mailbox.id)
  const result = { calendars: counts.calendars, events: counts.events }
  console.log('calendar-copy', JSON.stringify({ mailboxId: mailbox.id, ...result }))
  return result
}

/** Hourly: copies the calendars of store-held mailboxes nobody has opened yet. Returns how many were copied. */
export async function copyHeldCalendars(env: EmailEnv): Promise<number> {
  let done = 0
  for (const { id } of await mailboxesDb.heldByStore(env.DB)) {
    const mailbox = await mailboxesDb.find(env.DB, id)
    if (!mailbox) continue
    try {
      if (await ensureCopied(env, mailbox)) done++
    } catch (err) {
      // Busy (someone is opening it right now) or Stalwart unreachable: the next hour tries again.
      console.error(`calendar-copy for ${id} failed`, err)
    }
  }
  return done
}
