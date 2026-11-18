// Calendars and events. A mailbox's calendar is read and changed by the same people as its mail (mailContext in
// ./access): a personal mailbox's calendar only by its owner. Events live in Stalwart (JMAP Calendars, see
// ./stalwart/calendar), or in the mailbox's store once its mail is there (./calendar-backend, phase 3 of
// docs/mailbox-store-plan.md). Invitations to guests go out by email (from Stalwart, or through SES for store-held
// mailboxes), so outside guests count against the same sending caps and suppression list as email_send (./sending).

import * as eventsDb from '../db/email-events'
import * as mailboxAccessDb from '../db/mailbox-access'
import * as mailboxesDb from '../db/mailboxes'
import type { MailboxRow } from '../db/mailboxes'
import * as usersDb from '../db/users'
import { inMailboxScope } from '../auth/scope.ts'
import { loadMember, mailAccess, outOfScope } from './access'
import {
  eventFields,
  mailto,
  ownParticipantKey,
  participants,
  rekeyOverrides,
  timeFields,
  toEvent,
  type CalendarEvent,
  type EventInput,
  type GuestStatus,
} from './calendar-events'
import { parseIcs } from '../mailbox/ical-in'
import { serverBlobId, storeBlob } from '../mailbox/read'
import { EmailError, forbidden, notFound as missing } from './errors'
import { outsideAddresses, reserveCalendarSends, reserveSend } from './sending'
import { calendarsOf, type CalendarBackend } from './calendar-backend'
import * as jmap from './stalwart/calendar'
import type { Actor, EmailEnv } from './types'

export type Calendar = { id: string; name: string; isDefault: boolean; color: string | null }
export type { CalendarEvent, EventInput, Guest, GuestStatus, Repeat } from './calendar-events'
export { setUpCalendars } from './calendar-backend'

/** Most guests one event can have: Stalwart stores at most 20 participants per event, the organizer included. */
export const MAX_GUESTS = 19
/** Widest range one list call may cover: Stalwart expands repeats over at most 52 weeks and a day. */
const MAX_RANGE_DAYS = 365

// ---------------------------------------------------------------------------------------------------------------
// Calendars

/**
 * The mailbox's calendars, default first. The first time its owner looks, Stalwart's automatic calendar is renamed
 * "Work" and a "Personal" one is added.
 */
export async function listCalendars(env: EmailEnv, actor: Actor, mailboxId: string): Promise<Calendar[]> {
  const { cal, write } = await context(env, actor, mailboxId, 'read')
  const calendars = write ? await cal.setUp() : await cal.getCalendars()
  return calendars
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ id, name, isDefault, color }) => ({ id, name, isDefault, color }))
}

// ---------------------------------------------------------------------------------------------------------------
// Events

/** Events overlapping [from, to), with repeating events expanded into their occurrences, sorted by start. */
export async function listEvents(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  range: { from: string; to: string; calendarId?: string },
): Promise<CalendarEvent[]> {
  const { mailbox, cal } = await context(env, actor, mailboxId, 'read')
  const from = Date.parse(range.from)
  const to = Date.parse(range.to)
  if (!(to > from)) throw new EmailError('invalid', '"to" must be after "from"')
  if (to - from > MAX_RANGE_DAYS * 86400000) throw new EmailError('invalid', `At most ${MAX_RANGE_DAYS} days at a time`)

  const events = await cal.queryEvents({
    after: utc(from),
    before: utc(to),
    calendarId: range.calendarId,
  })
  const addresses = ownAddresses(mailbox)
  const series = [...new Set(events.map((e) => e.baseEventId).filter((id): id is string => !!id))]
  const rules = await cal.getRecurrenceRules(series)
  return events.map((e) => toEvent(e.baseEventId ? { ...e, recurrenceRule: rules.get(e.baseEventId) ?? null } : e, addresses))
}

export async function getEvent(env: EmailEnv, actor: Actor, mailboxId: string, eventId: string): Promise<CalendarEvent> {
  const { mailbox, cal } = await context(env, actor, mailboxId, 'read')
  const event = await cal.getEvent(eventId)
  if (!event) throw notFound()
  if (event.baseEventId && !event.recurrenceRule) {
    event.recurrenceRule = (await cal.getRecurrenceRules([event.baseEventId])).get(event.baseEventId) ?? null
  }
  return toEvent(event, ownAddresses(mailbox))
}

/** Creates an event. With guests, invitations are sent to them unless notify is false. */
export async function createEvent(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  input: EventInput & { notify?: boolean },
): Promise<CalendarEvent> {
  const { mailbox, cal } = await context(env, actor, mailboxId, 'write')
  const calendarId = input.calendarId ?? (await defaultCalendarId(cal))
  const people = participants(await organizerOf(env, actor, mailbox), input.guests ?? [], null)
  const fields = { ...readable(() => eventFields(input)), calendarIds: { [calendarId]: true }, participants: people }

  const notify = input.notify !== false && !!people
  const id = await withSendingCaps(env, mailbox, notify ? guestEmails(people) : [], () =>
    cal.createEvent(fields, notify),
  )
  return getEvent(env, actor, mailboxId, id)
}

/**
 * Changes an event. scope 'series' (the default) changes the whole event, or every occurrence of a repeating one;
 * 'occurrence' changes only the occurrence named by `occurrence` (its title, text and time). Only the organizer
 * may change an event with guests; guests answer with respondToEvent instead.
 */
export async function updateEvent(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  eventId: string,
  input: EventInput & { scope?: 'series' | 'occurrence'; occurrence?: string; notify?: boolean },
): Promise<CalendarEvent> {
  const { mailbox, cal } = await context(env, actor, mailboxId, 'write')
  const current = await cal.getEvent(eventId)
  if (!current) throw notFound()
  const addresses = ownAddresses(mailbox)
  if (!toEvent(current, addresses).isOrganizer) {
    throw new EmailError('not_organizer', "Only the organizer can change this event. You can accept or decline it.", 403)
  }

  let patch: Record<string, unknown>
  let people = current.participants ?? null
  if (input.scope === 'occurrence') {
    if (!current.recurrenceRule || !input.occurrence) {
      throw new EmailError('invalid', 'Changing one occurrence needs a repeating event and the occurrence')
    }
    if (input.allDay !== !!current.showWithoutTime) {
      throw new EmailError('invalid', "One occurrence can't switch between all-day and timed; change the whole event")
    }
    const time = readable(() => timeFields(input))
    const key = localKey(input.occurrence)
    // Overrides are written as a whole map: a patch path into a map that doesn't exist yet fails on Stalwart.
    const overrides = { ...(current.recurrenceOverrides ?? {}) }
    const change: Record<string, unknown> = {
      title: input.title,
      description: input.description ?? '',
      locations: input.location ? { l: { '@type': 'Location', name: input.location } } : null,
    }
    // Only a real move is stored, so a renamed occurrence still follows the series if its time changes later.
    if (time.start !== key) change.start = time.start
    if (time.duration !== current.duration) change.duration = time.duration
    overrides[key] = change
    patch = { recurrenceOverrides: overrides }
  } else {
    patch = readable(() => eventFields(input))
    // Left out means unchanged; an empty list removes every guest (they get a cancellation).
    if (input.guests !== undefined) {
      people = participants(await organizerOf(env, actor, mailbox), input.guests, current.participants)
      patch.participants = people
    }
    if (input.calendarId) patch.calendarIds = { [input.calendarId]: true }
    // Changes to single occurrences are keyed by their original start: move them along with the series.
    if (current.recurrenceOverrides && Object.keys(current.recurrenceOverrides).length && patch.start !== current.start) {
      patch.recurrenceOverrides = rekeyOverrides(current.recurrenceOverrides, current.start, patch.start as string)
    }
  }

  // Guests still on the event get the update, removed ones a cancellation.
  const recipients = [...new Set([...guestEmails(current.participants ?? null), ...guestEmails(people)])]
  const notify = input.notify !== false && recipients.length > 0
  await withSendingCaps(env, mailbox, notify ? recipients : [], () =>
    cal.updateEvent(eventId, patch, notify),
  )
  return getEvent(env, actor, mailboxId, eventId)
}

/**
 * Deletes an event, or with `occurrence` only that occurrence of a repeating one. When this mailbox organizes it,
 * guests get a cancellation unless notify is false. A guest deleting it just removes it from their own calendar.
 */
export async function deleteEvent(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  eventId: string,
  options: { occurrence?: string; notify?: boolean } = {},
): Promise<void> {
  const { mailbox, cal } = await context(env, actor, mailboxId, 'write')
  const current = await cal.getEvent(eventId)
  if (!current) return
  const organizer = toEvent(current, ownAddresses(mailbox)).isOrganizer
  const notify = options.notify !== false && organizer && !!current.participants
  const recipients = notify ? guestEmails(current.participants ?? null) : []

  if (options.occurrence) {
    if (!current.recurrenceRule) throw new EmailError('invalid', 'This event does not repeat')
    const overrides = { ...(current.recurrenceOverrides ?? {}), [localKey(options.occurrence)]: { excluded: true } }
    await withSendingCaps(env, mailbox, recipients, () =>
      cal.updateEvent(eventId, { recurrenceOverrides: overrides }, notify),
    )
    return
  }
  await withSendingCaps(env, mailbox, recipients, () => cal.destroyEvent(eventId, notify))
}

/** Answers an invitation: accepted, tentative (maybe) or declined. The organizer is told by email. */
export async function respondToEvent(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  eventId: string,
  status: Exclude<GuestStatus, 'needs-action'>,
): Promise<CalendarEvent> {
  const { mailbox, cal } = await context(env, actor, mailboxId, 'write')
  const current = await cal.getEvent(eventId)
  if (!current) throw notFound()
  const event = toEvent(current, ownAddresses(mailbox))
  const key = ownParticipantKey(current.participants, ownAddresses(mailbox))
  if (!key || event.isOrganizer) throw new EmailError('not_invited', "You're not a guest of this event", 409)

  // Invites from other xstate mailboxes were filed by Stalwart, and changing the answer sends the reply. For one
  // from outside, added from its email, Stalwart sends nothing on a change (tested on 1.0.2), but it does send the
  // reply when the event is created with the answer, so that copy is quietly replaced. Its id changes.
  const outside = !!event.organizer && (await outsideAddresses(env.DB, [event.organizer])).length > 0
  const id = await withSendingCaps(env, mailbox, event.organizer ? [event.organizer] : [], async () => {
    // A store-held mailbox sends the answer itself (mailbox/scheduling.ts), whoever organizes the event.
    if (!outside || cal.kind === 'store') {
      await cal.updateEvent(eventId, { [`participants/${key}/participationStatus`]: status }, true)
      return eventId
    }
    const base = current.baseEventId ? await cal.getEvent(current.baseEventId) : current
    if (!base) throw notFound()
    const people = { ...(base.participants ?? {}) }
    const baseKey = ownParticipantKey(people, ownAddresses(mailbox)) ?? key
    people[baseKey] = { ...people[baseKey], participationStatus: status }
    const copy = { ...inviteFields(base, event.organizer!), participants: people, calendarIds: base.calendarIds }
    await cal.destroyEvent(base.id, false)
    return cal.createEvent(copy, true).catch(async (err) => {
      // Put the copy back as it was rather than lose it.
      await cal.createEvent({ ...inviteFields(base, event.organizer!), participants: base.participants, calendarIds: base.calendarIds }, false)
      throw err
    })
  })
  return getEvent(env, actor, mailboxId, id)
}

// ---------------------------------------------------------------------------------------------------------------
// Invites in email. An invitation email carries a text/calendar part with an iTIP method: request (an invite or
// an update), reply (a guest's answer) or cancel. Stalwart files invites from other xstate mailboxes straight into
// the calendar; ones from outside arrive as mail only, so these let the email view add, update, answer or remove.

export type InviteMethod = 'request' | 'reply' | 'cancel' | 'other'
export type Invite = {
  method: InviteMethod
  /** The event as the email describes it (id is empty: it isn't stored). */
  event: CalendarEvent
  /** Your calendar's copy, matched by the event's UID, or null when it isn't in your calendar. */
  existing: CalendarEvent | null
  /** The email is a newer version than your calendar's copy (the organizer changed it since). */
  outdated: boolean
  /** For a reply: the guest who answered and their answer. */
  answer: { email: string; name: string | null; status: GuestStatus } | null
}

export async function getInvite(env: EmailEnv, actor: Actor, mailboxId: string, blobId: string): Promise<Invite> {
  const { mailbox, cal } = await context(env, actor, mailboxId, 'read')
  const { parsed, existing } = await loadInvite(env, mailbox, cal, blobId)
  const addresses = ownAddresses(mailbox)
  const event = toEvent({ ...parsed, id: '', calendarIds: {} }, addresses)
  const method = inviteMethod(parsed.method)
  let answer: Invite['answer'] = null
  if (method === 'reply') {
    const guest = event.guests.find((g) => !g.organizer && g.status !== 'needs-action') ?? event.guests.find((g) => !g.organizer)
    if (guest) answer = { email: guest.email, name: guest.name, status: guest.status }
  }
  return {
    method,
    event,
    existing: existing ? toEvent(existing, addresses) : null,
    outdated: !!existing && (parsed.sequence ?? 0) > (existing.sequence ?? 0),
    answer,
  }
}

/**
 * Acts on an invitation email. For an invite: adds it to your default calendar if it isn't there yet, brings your
 * copy up to date if the email is newer, and with `status` answers the organizer (one email, counted against the
 * invitation caps). For a cancellation: removes your copy. Returns your calendar's copy, or null once removed.
 */
export async function applyInvite(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  blobId: string,
  status?: Exclude<GuestStatus, 'needs-action'>,
): Promise<CalendarEvent | null> {
  const { mailbox, cal } = await context(env, actor, mailboxId, 'write')
  const addresses = ownAddresses(mailbox)
  const { parsed, existing } = await loadInvite(env, mailbox, cal, blobId)
  const method = inviteMethod(parsed.method)

  if (method === 'cancel') {
    // A guest deleting their copy tells nobody; the organizer already knows.
    if (existing) await cal.destroyEvent(existing.id, false)
    return null
  }
  if (method !== 'request') throw new EmailError('invalid', 'This email has nothing to add to your calendar', 400)

  const organizer = mailto(parsed.organizerCalendarAddress) ?? toEvent({ ...parsed, id: '', calendarIds: {} }, addresses).organizer
  if (!organizer) throw new EmailError('invalid', "This invitation doesn't say who organizes it", 400)
  if (addresses.includes(organizer)) throw new EmailError('invalid', 'You organize this event; it is already in your calendar', 409)
  const fields = inviteFields(parsed, organizer)

  let id = existing?.id ?? null
  if (!id) {
    const calendarId = await defaultCalendarId(cal)
    const key = ownParticipantKey(parsed.participants, addresses)
    if (status && !key) throw new EmailError('not_invited', "You're not on this invitation's guest list", 409)
    const people = { ...(parsed.participants ?? {}) }
    if (status && key) people[key] = { ...people[key], participationStatus: status }
    const create = { ...fields, participants: people, calendarIds: { [calendarId]: true } }
    // Adding it with an answer sends that answer (a reply) to the organizer; adding it without one sends nothing.
    id = await withSendingCaps(env, mailbox, status ? [organizer] : [], () => cal.createEvent(create, !!status))
    return getEvent(env, actor, mailboxId, id)
  }

  if ((parsed.sequence ?? 0) > (existing!.sequence ?? 0)) {
    // Newer from the organizer: take their version, keeping your own answer.
    const key = ownParticipantKey(existing!.participants, addresses)
    const mine = key ? existing!.participants?.[key]?.participationStatus : undefined
    const people = { ...(parsed.participants ?? {}) }
    const newKey = ownParticipantKey(people, addresses)
    if (newKey && mine) people[newKey] = { ...people[newKey], participationStatus: mine }
    await cal.updateEvent(id, { ...fields, participants: people }, false)
  }
  if (status) return respondToEvent(env, actor, mailboxId, id, status)
  return getEvent(env, actor, mailboxId, id)
}

async function loadInvite(env: EmailEnv, mailbox: MailboxRow, cal: CalendarBackend, blobId: string) {
  // A store-held mailbox reads the file itself (mailbox/ical-in.ts); a Stalwart one has Stalwart parse it.
  const all = cal.kind === 'store' ? await readInvite(env, mailbox, blobId) : await jmap.parseInvite(env, mailbox.stalwart_id, await serverBlobId(env, mailbox, blobId, 'text/calendar'))
  // A repeating event's changed occurrences can come as extra entries; the first is the event itself.
  const parsed = all.find((e) => !e.recurrenceId) ?? all[0]
  if (!parsed) throw new EmailError('not_an_invite', "This attachment isn't a calendar invitation", 400)
  const existingId = parsed.uid ? await cal.findByUid(parsed.uid) : null
  const existing = existingId ? await cal.getEvent(existingId) : null
  return { parsed, existing }
}

/** An invitation file from the store, in the shape Stalwart's parse gives: the event (with its overrides), or its occurrences. */
async function readInvite(env: EmailEnv, mailbox: MailboxRow, blobId: string): Promise<jmap.ParsedInvite[]> {
  const blob = await storeBlob(env, mailbox, blobId)
  if (!blob) throw new EmailError('attachment_not_found', 'That attachment no longer exists', 404)
  const file = parseIcs(new TextDecoder().decode(blob.bytes))
  if (!file) return []
  if (file.event) return [{ ...file.event, method: file.method }]
  return Object.entries(file.occurrences).map(([key, o]) => ({ ...o, recurrenceId: key, method: file.method }))
}

function inviteMethod(method: string | null | undefined): InviteMethod {
  return method === 'request' || method === 'reply' || method === 'cancel' ? method : 'other'
}

/**
 * The event fields to store from a parsed invite. organizerCalendarAddress must be set: without it Stalwart takes
 * the mailbox for the organizer and would email the real organizer a new invitation instead of an answer.
 */
function inviteFields(parsed: jmap.JmapEvent, organizer: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    '@type': 'Event',
    uid: parsed.uid,
    sequence: parsed.sequence ?? 0,
    title: parsed.title ?? '',
    description: parsed.description ?? '',
    start: parsed.start,
    duration: parsed.duration ?? 'PT0S',
    timeZone: parsed.timeZone ?? null,
    showWithoutTime: !!parsed.showWithoutTime,
    locations: parsed.locations ?? null,
    organizerCalendarAddress: `mailto:${organizer}`,
  }
  if (parsed.recurrenceRule) fields.recurrenceRule = parsed.recurrenceRule
  if (parsed.recurrenceOverrides) fields.recurrenceOverrides = parsed.recurrenceOverrides
  if (parsed.status) fields.status = parsed.status
  return fields
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/** Same rules as mailContext, plus whether the caller could also change things (to set up default calendars). */
async function context(env: EmailEnv, actor: Actor, mailboxId: string, need: 'read' | 'write') {
  const mailbox = await mailboxesDb.find(env.DB, mailboxId)
  if (!mailbox) throw missing('mailbox')
  const member = await loadMember(env, mailbox.organization_id, actor.userId)
  const own = (await mailboxAccessDb.find(env.DB, mailbox.id, member.id))?.access
  const access = mailAccess(member, mailbox, own)
  // Same answer as a missing mailbox, so people can't probe which mailboxes exist.
  if (!access.read) throw missing('mailbox')
  if (!inMailboxScope(actor, mailbox.id)) throw outOfScope()
  if (need === 'write' && !access.write) throw forbidden('You can only read this calendar')
  return { mailbox, member, write: access.write, cal: await calendarsOf(env, mailbox) }
}


/** Who invitations come from: your own name on your personal mailbox, otherwise the mailbox's name. */
async function organizerOf(env: EmailEnv, actor: Actor, mailbox: MailboxRow) {
  const user = mailbox.kind === 'personal' ? await usersDb.findById(env.DB, actor.userId) : null
  return { email: mailbox.address, name: user?.name ?? mailbox.display_name ?? null }
}

async function defaultCalendarId(cal: CalendarBackend): Promise<string> {
  const calendars = await cal.setUp()
  const calendar = calendars.find((c) => c.isDefault) ?? calendars[0]
  if (!calendar) throw new EmailError('calendar_not_found', 'This mailbox has no calendar', 409)
  return calendar.id
}

/**
 * Runs a change that emails these people (one email each). Refuses suppressed addresses, then holds the emails
 * against the invitation caps (every recipient) and outside ones against the email_send caps (./sending), released
 * again if the change fails.
 */
async function withSendingCaps<T>(
  env: EmailEnv,
  mailbox: MailboxRow,
  recipients: string[],
  change: () => Promise<T>,
): Promise<T> {
  if (!recipients.length) return change()
  if (recipients.length > MAX_GUESTS) throw new EmailError('too_many_guests', `An event can have at most ${MAX_GUESTS} guests`)
  const blocked = await eventsDb.suppressedFor(env.DB, mailbox.organization_id, recipients)
  if (blocked.length) {
    const list = blocked.map((b) => `${b.address} (${b.reason === 'bounce' ? 'address does not exist' : 'marked your mail as spam'})`)
    throw new EmailError('recipient_suppressed', `Not inviting ${list.join(', ')}. Remove them and try again.`, 409)
  }
  const invites = await reserveCalendarSends(env, mailbox, recipients)
  const outside = await reserveSend(env, mailbox, recipients).catch(async (err) => {
    await invites.release()
    throw err
  })
  return change().catch(async (err) => {
    await Promise.all([invites.release(), outside.release()])
    throw err
  })
}

function guestEmails(people: Record<string, { calendarAddress?: string; roles?: Record<string, true> }> | null): string[] {
  return Object.values(people ?? {})
    .filter((p) => !p.roles?.owner)
    .map((p) => (p.calendarAddress ?? '').replace(/^mailto:/i, '').toLowerCase())
    .filter((e) => e.includes('@'))
}

function ownAddresses(mailbox: MailboxRow): string[] {
  let aliases: string[] = []
  try {
    aliases = JSON.parse(mailbox.aliases ?? '[]') as string[]
  } catch {
    // A malformed list just means no aliases.
  }
  return [mailbox.address, ...aliases].map((a) => a.toLowerCase())
}

/** Turns plain Errors from the input mapping (bad dates, missing zone) into 400s. */
function readable<T>(build: () => T): T {
  try {
    return build()
  } catch (err) {
    if (err instanceof EmailError) throw err
    throw new EmailError('invalid', err instanceof Error ? err.message : String(err))
  }
}

/** An occurrence key as JSCalendar writes it: the local start with seconds. */
function localKey(occurrence: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(occurrence) ? `${occurrence}:00` : occurrence.slice(0, 19)
}

function utc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + 'Z'
}

function notFound(): EmailError {
  return missing('event')
}
