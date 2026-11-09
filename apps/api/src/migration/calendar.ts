// Copying one person's Google calendars into their xstate mailbox's calendars (Stalwart, JMAP Calendars). Only the
// calendars they own: the primary one goes into their default calendar ("Work"), each other one into a calendar of
// the same name. Per calendar, two listings, one page per queue job:
//   events       single events and repeating series, imported as they are (claimed first in the MigrationStore,
//                so a retry never adds one twice)
//   occurrences  changed or cancelled occurrences, written into their series (Google may list them before it)
// Nothing is ever sent to guests. The sync token Google gives at the end of the first listing is what the final
// pass (calendarFinalPage, after the switch) reads changes from.

import * as mailboxesDb from '../db/mailboxes'
import type { MailboxRow } from '../db/mailboxes'
import * as migrationsDb from '../db/migrations'
import type { MigrationUserRow } from '../db/migrations'
import { setUpCalendars } from '../mailserver'
import * as jmap from '../mailserver/stalwart/calendar'
import { convertEvent, occurrenceOverride, skipReason, type ConvertContext } from './calendar-rules'
import { finishIfDone } from './final'
import { GoogleError } from './google/auth'
import { workspace, type GEvent } from './google/workspace'
import { enqueueMigrationJobs, HELD_RETRY_SECONDS } from './jobs'
import { migrationStore } from './store'

export type CalendarJob = { kind: 'calendar'; migrationId: string; googleId: string; chain: number }
export type CalendarFinalJob = { kind: 'final_calendar'; migrationId: string; owner: string; run: number }

type CalendarEntry = { id: string; name: string; primary: boolean; timeZone: string | null; target: string; syncToken: string | null }
type Cursor = { calendars: CalendarEntry[]; index: number; phase: 'events' | 'occurrences'; pageToken: string | null }
type FinalCursor = { index: number; pageToken: string | null; full: boolean }

const NO_ACCESS =
  'xstate can’t read this person’s calendar. In Google Admin, add the calendar scope to xstate’s domain-wide delegation, then retry.'

export async function copyCalendarPage(env: Env, job: CalendarJob): Promise<void> {
  const m = await migrationsDb.find(env.DB, job.migrationId)
  if (!m || m.status === 'cancelled' || m.paused_at || m.access_lost_at) return
  const u = await migrationsDb.findUser(env.DB, job.migrationId, job.googleId)
  if (!u || u.calendar_chain !== job.chain || !u.copy_calendar || u.calendar_state === 'done' || u.calendar_state === 'attention') return
  const mailbox = u.mailbox_id ? await mailboxesDb.find(env.DB, u.mailbox_id) : null
  if (!mailbox) return setState(env, u, 'done', 'No mailbox to copy the calendar into')

  try {
    await copyPage(env, job, m.organization_id, u, mailbox)
  } catch (err) {
    // Only this part: a migration verified before calendars were copied may simply lack the calendar scope.
    if (err instanceof GoogleError && (err.code === 'not_authorized' || err.code === 'forbidden')) return setState(env, u, 'attention', NO_ACCESS)
    if (err instanceof GoogleError && err.code === 'no_such_user') {
      return setState(env, u, 'attention', 'Google won’t let xstate read this account’s calendar (suspended or deleted).')
    }
    throw err
  }
}

async function copyPage(env: Env, job: CalendarJob, organizationId: string, u: MigrationUserRow, mailbox: MailboxRow) {
  const ws = workspace(env)
  const store = migrationStore(env, organizationId)
  const accountId = mailbox.stalwart_id
  let cursor = u.calendar_cursor ? (JSON.parse(u.calendar_cursor) as Cursor) : null
  if (!cursor) {
    cursor = { calendars: await targetCalendars(env, u, accountId, store), index: 0, phase: 'events', pageToken: null }
    await env.DB.prepare("UPDATE migration_users SET calendar_state = 'copying', calendar_cursor = ? WHERE migration_id = ? AND google_id = ?")
      .bind(JSON.stringify(cursor), u.migration_id, u.google_id)
      .run()
  }
  const cal = cursor.calendars[cursor.index]
  if (!cal) return setState(env, u, 'done', null)

  const page = await ws.eventsPage(u.email, cal.id, { pageToken: cursor.pageToken, syncToken: null })
  const ctx = contextFor(u, mailbox, cal)
  let held = 0
  if (cursor.phase === 'events') {
    const claim = `${job.migrationId}:${u.google_id}:${job.chain}:${cal.id}:${cursor.pageToken ?? 'first'}`
    held = await importEvents(env, accountId, store, u.google_id, cal, ctx, page.events.filter((e) => !e.recurringEventId), claim)
  } else {
    await applyOccurrences(env, accountId, store, u.google_id, cal, page.events.filter((e) => !!e.recurringEventId))
  }

  // Next: this listing's next page, else the occurrences listing, else the next calendar. Held items: come back.
  if (held) cursor = { ...cursor }
  else if (page.nextPageToken) cursor = { ...cursor, pageToken: page.nextPageToken }
  else if (cursor.phase === 'events') {
    // Changes from here on reach the final pass through this token (occurrences re-applied there are harmless).
    cursor.calendars[cursor.index] = { ...cal, syncToken: page.nextSyncToken }
    cursor = { ...cursor, phase: 'occurrences', pageToken: null }
  } else cursor = { ...cursor, index: cursor.index + 1, phase: 'events', pageToken: null }

  const { copied, skipped } = await store.counts('event', u.google_id)
  await env.DB.prepare('UPDATE migration_users SET calendar_done = ?, calendar_cursor = ?, calendar_note = NULL WHERE migration_id = ? AND google_id = ?')
    .bind(copied + skipped, JSON.stringify(cursor), u.migration_id, u.google_id)
    .run()
  if (cursor.index < cursor.calendars.length) {
    await enqueueMigrationJobs(env, [{ kind: 'calendar', migrationId: job.migrationId, googleId: u.google_id, chain: job.chain }], held ? HELD_RETRY_SECONDS : undefined)
  } else {
    await setState(env, u, 'done', null)
    if (u.final_calendar === 'running') await finishIfDone(env, u.migration_id)
  }
}

/** The person's Google calendars, each with the xstate calendar it goes into (made here when needed). */
async function targetCalendars(env: Env, u: MigrationUserRow, accountId: string, store: ReturnType<typeof migrationStore>): Promise<CalendarEntry[]> {
  const ws = workspace(env)
  const [google, xstate] = await Promise.all([ws.calendarList(u.email), setUpCalendars(env, accountId)])
  const main = xstate.find((c) => c.isDefault) ?? xstate[0]
  if (!main) throw new Error('This mailbox has no calendar')
  const others = google.filter((c) => !c.primary)
  // Made once per Google calendar, even when a job is retried: the store remembers what each became.
  const made = await store.targets('calendar', u.google_id, others.map((c) => c.id))
  const out: CalendarEntry[] = []
  for (const c of google) {
    let target = c.primary ? main.id : made[c.id]
    if (!target) {
      target = await jmap.createCalendar(env, accountId, c.name.slice(0, 100))
      await store.record('calendar', u.google_id, [{ sourceId: c.id, targetId: target }])
    }
    out.push({ id: c.id, name: c.name, primary: c.primary, timeZone: c.timeZone, target, syncToken: null })
  }
  return out
}

function contextFor(u: MigrationUserRow, mailbox: MailboxRow, cal: CalendarEntry): ConvertContext {
  let aliases: string[] = []
  try {
    aliases = JSON.parse(u.aliases) as string[]
  } catch {
    // No aliases.
  }
  return { timeZone: cal.timeZone ?? 'Etc/UTC', googleAddresses: [u.email, ...aliases], address: mailbox.address }
}

/** Store keys are per calendar: Google event ids are only unique within one. */
const keyOf = (cal: CalendarEntry, id: string) => `${cal.id}/${id}`

/** Imports single events and series. Returns how many were held by another job's claim. */
async function importEvents(
  env: Env,
  accountId: string,
  store: ReturnType<typeof migrationStore>,
  owner: string,
  cal: CalendarEntry,
  ctx: ConvertContext,
  events: GEvent[],
  claim: string,
): Promise<number> {
  const claimed = await store.claim('event', owner, events.map((e) => keyOf(cal, e.id)), claim)
  const mine = new Set(claimed.mine)
  const todo = events.filter((e) => mine.has(keyOf(cal, e.id)))
  const skipped = todo.flatMap((e) => {
    const reason = skipReason(e)
    return reason ? [{ sourceId: keyOf(cal, e.id), reason }] : []
  })
  const creates: Record<string, Record<string, unknown>> = {}
  const notes: { sourceId: string; reason: string; detail: string }[] = []
  for (const e of todo) {
    if (skipReason(e)) continue
    const { fields, trimmed } = convertEvent(e, ctx)
    creates[e.id] = { ...fields, calendarIds: { [cal.target]: true } }
    if (trimmed) notes.push({ sourceId: keyOf(cal, e.id), reason: 'guests_trimmed', detail: `${trimmed} guests left off` })
  }
  const { created, failed } = await jmap.importEvents(env, accountId, creates)
  await store.record('event', owner, Object.entries(created).map(([id, target]) => ({ sourceId: keyOf(cal, id), targetId: target })))
  const problems = [...skipped, ...Object.entries(failed).map(([id, detail]) => ({ sourceId: keyOf(cal, id), reason: 'event_refused', detail: detail.slice(0, 300) }))]
  if (problems.length) await store.skip('event', owner, problems)
  // Copied, but worth a line in the report. Their own kind, so they don't count as skipped.
  if (notes.length) await store.skip('event_note', owner, notes)
  return claimed.held
}

/** Writes changed and cancelled occurrences into their series, one update per series. */
async function applyOccurrences(env: Env, accountId: string, store: ReturnType<typeof migrationStore>, owner: string, cal: CalendarEntry, events: GEvent[]) {
  if (!events.length) return
  const series = [...new Set(events.map((e) => e.recurringEventId!))]
  const targets = await store.targets('event', owner, series.map((id) => keyOf(cal, id)))
  for (const seriesId of series) {
    const target = targets[keyOf(cal, seriesId)]
    const mine = events.filter((e) => e.recurringEventId === seriesId)
    if (!target) {
      // The series wasn't copied (cancelled, or refused): nothing to attach these to.
      await store.skip('event', owner, mine.map((e) => ({ sourceId: keyOf(cal, e.id), reason: 'no_series' })))
      continue
    }
    const current = await jmap.getEvent(env, accountId, target)
    if (!current) continue
    const overrides = { ...(current.recurrenceOverrides ?? {}) }
    for (const e of mine) {
      const o = occurrenceOverride(e, current.showWithoutTime ? null : (current.timeZone ?? null), current.duration ?? null)
      if (o) overrides[o.key] = { ...(overrides[o.key] as object | undefined), ...o.value }
    }
    // The whole map: a patch path into a map that doesn't exist yet fails on Stalwart.
    await jmap.updateEvent(env, accountId, target, { recurrenceOverrides: overrides }, false)
    await store.record('event', owner, mine.map((e) => ({ sourceId: keyOf(cal, e.id), targetId: target })))
  }
}

async function setState(env: Env, u: MigrationUserRow, state: 'done' | 'attention', note: string | null) {
  await env.DB.prepare('UPDATE migration_users SET calendar_state = ?, calendar_note = ? WHERE migration_id = ? AND google_id = ?')
    .bind(state, note, u.migration_id, u.google_id)
    .run()
}

// ---------------------------------------------------------------------------------------------------------------
// Final pass: what changed in Google since the copy, through each calendar's sync token. New events are added,
// changed ones replaced, deleted ones removed, changed occurrences written into their series. If Google's change
// list expired, the calendar is listed in full and treated the same way (nothing is added twice).

export async function calendarFinalPage(env: Env, job: CalendarFinalJob): Promise<void> {
  const m = await migrationsDb.find(env.DB, job.migrationId)
  const u = m && (await migrationsDb.findUser(env.DB, job.migrationId, job.owner))
  if (!m || !u || u.final_calendar !== 'running') return
  const mailbox = u.mailbox_id ? await mailboxesDb.find(env.DB, u.mailbox_id) : null
  const cursor = u.calendar_cursor ? (JSON.parse(u.calendar_cursor) as Cursor) : null
  const done = async (note: string | null) => {
    await env.DB.prepare("UPDATE migration_users SET final_calendar = 'done', final_calendar_cursor = NULL, calendar_note = COALESCE(?, calendar_note) WHERE migration_id = ? AND google_id = ?")
      .bind(note, u.migration_id, u.google_id)
      .run()
    await finishIfDone(env, u.migration_id)
  }
  if (!mailbox || !cursor) return done(null)

  const at = u.final_calendar_cursor ? (JSON.parse(u.final_calendar_cursor) as FinalCursor) : { index: 0, pageToken: null, full: false }
  const cal = cursor.calendars[at.index]
  if (!cal) return done(null)

  let page
  try {
    page = await workspace(env).eventsPage(u.email, cal.id, { pageToken: at.pageToken, syncToken: at.full || at.pageToken ? null : cal.syncToken })
  } catch (err) {
    if (err instanceof GoogleError && err.code === 'gone') {
      // Too long since the copy: list this calendar in full instead.
      await saveFinal(env, u, { index: at.index, pageToken: null, full: true }, 0)
      return enqueueMigrationJobs(env, [job])
    }
    if (err instanceof GoogleError && (err.code === 'not_authorized' || err.code === 'forbidden' || err.code === 'no_such_user')) return done(`Final pass: ${NO_ACCESS}`)
    throw err
  }

  const changes = await applyChanges(env, m.organization_id, u, mailbox, cal, page.events, at.full)
  let next: FinalCursor | null
  if (page.nextPageToken) next = { ...at, pageToken: page.nextPageToken }
  else {
    // Keep the newest token: the automatic second pass, 24 hours later, starts from here.
    cursor.calendars[at.index] = { ...cal, syncToken: page.nextSyncToken ?? cal.syncToken }
    await env.DB.prepare('UPDATE migration_users SET calendar_cursor = ? WHERE migration_id = ? AND google_id = ?').bind(JSON.stringify(cursor), u.migration_id, u.google_id).run()
    next = at.index + 1 < cursor.calendars.length ? { index: at.index + 1, pageToken: null, full: false } : null
  }
  await saveFinal(env, u, next, changes)
  if (next) await enqueueMigrationJobs(env, [job])
  else await done(null)
}

async function saveFinal(env: Env, u: MigrationUserRow, cursor: FinalCursor | null, changes: number) {
  await env.DB.prepare('UPDATE migration_users SET final_calendar_cursor = ?, final_calendar_changes = final_calendar_changes + ? WHERE migration_id = ? AND google_id = ?')
    .bind(cursor ? JSON.stringify(cursor) : null, changes, u.migration_id, u.google_id)
    .run()
}

/** Applies a page of changes (or of a full listing). Returns how many changed anything. */
async function applyChanges(
  env: Env,
  organizationId: string,
  u: MigrationUserRow,
  mailbox: MailboxRow,
  cal: CalendarEntry,
  events: GEvent[],
  full: boolean,
): Promise<number> {
  const store = migrationStore(env, organizationId)
  const accountId = mailbox.stalwart_id
  const ctx = contextFor(u, mailbox, cal)
  const owner = u.google_id
  const whole = events.filter((e) => !e.recurringEventId)
  const targets = await store.targets('event', owner, whole.map((e) => keyOf(cal, e.id)))
  let changed = 0
  const creates: GEvent[] = []

  for (const e of whole) {
    const target = targets[keyOf(cal, e.id)]
    if (!target) {
      if (!skipReason(e)) creates.push(e)
      continue
    }
    if (skipReason(e)) {
      // Deleted in Google (or turned into something we don't copy): remove our copy, never emailing anyone.
      await jmap.destroyEvent(env, accountId, target, false)
      changed++
      continue
    }
    const current = await jmap.getEvent(env, accountId, target)
    // Our copy is gone (deleted in xstate since): leave it gone rather than bring it back.
    if (!current) continue
    // A full listing (after an expired token) goes through every event: never apply an older version than ours,
    // and skip ones that look unchanged. (Stalwart may bump sequence on its own, so a tie compares the title.)
    if (full && ((current.sequence ?? 0) > (e.sequence ?? 0) || ((current.sequence ?? 0) === (e.sequence ?? 0) && current.title === (e.summary ?? '')))) continue
    const { fields } = convertEvent(e, ctx)
    // Keep occurrences changed earlier; add the series' own excluded dates.
    const overrides = { ...(current.recurrenceOverrides ?? {}), ...((fields.recurrenceOverrides as object | undefined) ?? {}) }
    await jmap.updateEvent(env, accountId, target, { ...fields, recurrenceOverrides: Object.keys(overrides).length ? overrides : null }, false)
    changed++
  }
  if (creates.length) {
    const claim = `final:${owner}:${cal.id}:${Date.now()}`
    await importEvents(env, accountId, store, owner, cal, ctx, creates, claim)
    changed += creates.length
  }
  const occurrences = events.filter((e) => !!e.recurringEventId)
  if (occurrences.length) {
    await applyOccurrences(env, accountId, store, owner, cal, occurrences)
    changed += occurrences.length
  }
  return changed
}
