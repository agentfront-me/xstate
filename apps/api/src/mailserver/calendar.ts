// Calendars and events. A mailbox's calendar is read and changed by the same people as its mail (mailContext in
// ./access): a personal mailbox's calendar only by its owner. Events live in Stalwart (JMAP Calendars, see
// ./stalwart/calendar); invitations to guests go out from Stalwart by email, so outside guests count against the
// same sending caps and suppression list as email_send (./sending).

import * as eventsDb from '../db/email-events'
import * as mailboxAccessDb from '../db/mailbox-access'
import * as mailboxesDb from '../db/mailboxes'
import type { MailboxRow } from '../db/mailboxes'
import * as usersDb from '../db/users'
import { loadMember, mailAccess } from './access'
import {
  eventFields,
  ownParticipantKey,
  participants,
  rekeyOverrides,
  timeFields,
  toEvent,
  type CalendarEvent,
  type EventInput,
  type GuestStatus,
} from './calendar-events'
import { EmailError, forbidden, notFound as missing } from './errors'
import { reserveCalendarSends, reserveSend } from './sending'
import * as jmap from './stalwart/calendar'
import type { Actor, EmailEnv } from './types'

export type Calendar = { id: string; name: string; isDefault: boolean; color: string | null }
export type { CalendarEvent, EventInput, Guest, GuestStatus, Repeat } from './calendar-events'

/** Most guests one event can have: inviting them all uses an hour's invitation emails (CALENDAR_LIMITS). */
export const MAX_GUESTS = 30
/** Widest range one list call may cover. */
const MAX_RANGE_DAYS = 400
/** The name Stalwart gives the calendar it creates with every account. */
const STALWART_DEFAULT = /^Stalwart Calendar\b/

// ---------------------------------------------------------------------------------------------------------------
// Calendars

/**
 * The mailbox's calendars, default first. The first time its owner looks, Stalwart's automatic calendar is renamed
 * "Work" and a "Personal" one is added.
 */
export async function listCalendars(env: EmailEnv, actor: Actor, mailboxId: string): Promise<Calendar[]> {
  const { mailbox, write } = await context(env, actor, mailboxId, 'read')
  let calendars = await jmap.getCalendars(env, mailbox.stalwart_id)
  if (write && calendars.length === 1 && STALWART_DEFAULT.test(calendars[0]!.name)) {
    await jmap.setCalendars(env, mailbox.stalwart_id, {
      update: { [calendars[0]!.id]: { name: 'Work' } },
      create: { personal: { name: 'Personal', sortOrder: 1 } },
    })
    calendars = await jmap.getCalendars(env, mailbox.stalwart_id)
  }
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
  const { mailbox } = await context(env, actor, mailboxId, 'read')
  const from = Date.parse(range.from)
  const to = Date.parse(range.to)
  if (!(to > from)) throw new EmailError('invalid', '"to" must be after "from"')
  if (to - from > MAX_RANGE_DAYS * 86400000) throw new EmailError('invalid', `At most ${MAX_RANGE_DAYS} days at a time`)

  const events = await jmap.queryEvents(env, mailbox.stalwart_id, {
    after: utc(from),
    before: utc(to),
    calendarId: range.calendarId,
  })
  const addresses = ownAddresses(mailbox)
  const series = [...new Set(events.map((e) => e.baseEventId).filter((id): id is string => !!id))]
  const rules = await jmap.getRecurrenceRules(env, mailbox.stalwart_id, series)
  return events.map((e) => toEvent(e.baseEventId ? { ...e, recurrenceRule: rules.get(e.baseEventId) ?? null } : e, addresses))
}

export async function getEvent(env: EmailEnv, actor: Actor, mailboxId: string, eventId: string): Promise<CalendarEvent> {
  const { mailbox } = await context(env, actor, mailboxId, 'read')
  const event = await jmap.getEvent(env, mailbox.stalwart_id, eventId)
  if (!event) throw notFound()
  if (event.baseEventId && !event.recurrenceRule) {
    event.recurrenceRule = (await jmap.getRecurrenceRules(env, mailbox.stalwart_id, [event.baseEventId])).get(event.baseEventId) ?? null
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
  const { mailbox } = await context(env, actor, mailboxId, 'write')
  const accountId = mailbox.stalwart_id
  const calendarId = input.calendarId ?? (await defaultCalendarId(env, accountId))
  const people = participants(await organizerOf(env, actor, mailbox), input.guests ?? [], null)
  const fields = { ...readable(() => eventFields(input)), calendarIds: { [calendarId]: true }, participants: people }

  const notify = input.notify !== false && !!people
  const id = await withSendingCaps(env, mailbox, notify ? guestEmails(people) : [], () =>
    jmap.createEvent(env, accountId, fields, notify),
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
  const { mailbox } = await context(env, actor, mailboxId, 'write')
  const accountId = mailbox.stalwart_id
  const current = await jmap.getEvent(env, accountId, eventId)
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
    jmap.updateEvent(env, accountId, eventId, patch, notify),
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
  const { mailbox } = await context(env, actor, mailboxId, 'write')
  const accountId = mailbox.stalwart_id
  const current = await jmap.getEvent(env, accountId, eventId)
  if (!current) return
  const organizer = toEvent(current, ownAddresses(mailbox)).isOrganizer
  const notify = options.notify !== false && organizer && !!current.participants
  const recipients = notify ? guestEmails(current.participants ?? null) : []

  if (options.occurrence) {
    if (!current.recurrenceRule) throw new EmailError('invalid', 'This event does not repeat')
    const overrides = { ...(current.recurrenceOverrides ?? {}), [localKey(options.occurrence)]: { excluded: true } }
    await withSendingCaps(env, mailbox, recipients, () =>
      jmap.updateEvent(env, accountId, eventId, { recurrenceOverrides: overrides }, notify),
    )
    return
  }
  await withSendingCaps(env, mailbox, recipients, () => jmap.destroyEvent(env, accountId, eventId, notify))
}

/** Answers an invitation: accepted, tentative (maybe) or declined. The organizer is told by email. */
export async function respondToEvent(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  eventId: string,
  status: Exclude<GuestStatus, 'needs-action'>,
): Promise<CalendarEvent> {
  const { mailbox } = await context(env, actor, mailboxId, 'write')
  const accountId = mailbox.stalwart_id
  const current = await jmap.getEvent(env, accountId, eventId)
  if (!current) throw notFound()
  const event = toEvent(current, ownAddresses(mailbox))
  const key = ownParticipantKey(current.participants, ownAddresses(mailbox))
  if (!key || event.isOrganizer) throw new EmailError('not_invited', "You're not a guest of this event", 409)

  await withSendingCaps(env, mailbox, event.organizer ? [event.organizer] : [], () =>
    jmap.updateEvent(env, accountId, eventId, { [`participants/${key}/participationStatus`]: status }, true),
  )
  return getEvent(env, actor, mailboxId, eventId)
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
  if (need === 'write' && !access.write) throw forbidden('You can only read this calendar')
  return { mailbox, member, write: access.write }
}


/** Who invitations come from: your own name on your personal mailbox, otherwise the mailbox's name. */
async function organizerOf(env: EmailEnv, actor: Actor, mailbox: MailboxRow) {
  const user = mailbox.kind === 'personal' ? await usersDb.findById(env.DB, actor.userId) : null
  return { email: mailbox.address, name: user?.name ?? mailbox.display_name ?? null }
}

async function defaultCalendarId(env: EmailEnv, accountId: string): Promise<string> {
  const calendars = await jmap.getCalendars(env, accountId)
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
