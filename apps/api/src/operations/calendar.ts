import { z } from 'zod'
import * as mailserver from '../mailserver'
import { defineOperation } from './define'

// A mailbox's calendar is read and changed by the same people as its mail: a personal mailbox's only by its owner.

const id = z.string().min(1).max(64)
const eventId = z.string().min(1).max(128)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/, 'Use YYYY-MM-DDTHH:mm in the event time zone, or YYYY-MM-DD')
const timeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz })
      return true
    } catch {
      return false
    }
  }, 'Unknown time zone; use an IANA name such as Europe/London')
const flag = z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')])

const repeat = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(99).optional(),
  days: z.array(z.enum(['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'])).max(7).optional(),
  until: date.nullable().optional(),
  count: z.number().int().min(1).max(999).nullable().optional(),
})

const guest = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().max(100).nullable().optional(),
  optional: z.boolean().optional(),
})

const eventFields = {
  calendarId: id.optional(),
  title: z.string().trim().min(1, 'Add a title').max(300),
  description: z.string().max(20_000).optional(),
  location: z.string().trim().max(500).optional(),
  allDay: z.boolean().default(false),
  start: localDateTime,
  end: localDateTime,
  timeZone: timeZone.optional(),
  repeat: repeat.nullable().optional(),
  guests: z.array(guest).max(mailserver.MAX_GUESTS).optional(),
  notify: z.boolean().optional(),
}

const EVENT_SHAPE =
  'Each event has id, seriesId and occurrence (set on one occurrence of a repeating event), calendarId, status ' +
  '(confirmed, tentative, or cancelled when the organizer called it off), title, ' +
  'description, location, allDay, start and end (UTC instants, or dates with an exclusive end for all-day events), ' +
  'localStart, localEnd and timeZone (as entered), repeat, guests (email, name, organizer, optional, status), ' +
  'organizer, isOrganizer and myStatus (your answer when invited).'

export const calendarListCalendars = defineOperation({
  name: 'calendar_list_calendars',
  description:
    "List a mailbox's calendars (id, name, isDefault, color), default first. A personal mailbox starts with Work " +
    '(the default) and Personal.',
  input: z.object({ mailboxId: id }),
  http: { method: 'GET', path: '/calendar/mailboxes/:mailboxId/calendars' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({ calendars: await mailserver.listCalendars(env, actor, input.mailboxId) }),
})

export const calendarListEvents = defineOperation({
  name: 'calendar_list_events',
  description:
    'List the events in a mailbox calendar between from and to (ISO date-times; at most 365 days apart), sorted by ' +
    'start. Repeating events come back once per occurrence. Optionally only one calendarId. ' +
    EVENT_SHAPE,
  input: z.object({
    mailboxId: id,
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    calendarId: id.optional(),
  }),
  http: { method: 'GET', path: '/calendar/mailboxes/:mailboxId/events' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, { mailboxId, ...range }) => ({
    events: await mailserver.listEvents(env, actor, mailboxId, range),
  }),
})

export const calendarGetEvent = defineOperation({
  name: 'calendar_get_event',
  description: 'Get one event, or one occurrence of a repeating event, by the id from calendar_list_events.',
  input: z.object({ mailboxId: id, eventId }),
  http: { method: 'GET', path: '/calendar/mailboxes/:mailboxId/events/:eventId' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({ event: await mailserver.getEvent(env, actor, input.mailboxId, input.eventId) }),
})

export const calendarCreateEvent = defineOperation({
  name: 'calendar_create_event',
  description:
    'Create an event in a mailbox calendar (the default calendar unless calendarId is given). start and end are ' +
    'local times in timeZone (YYYY-MM-DDTHH:mm); for allDay events they are dates and end is the last day. ' +
    'repeat makes it repeat (frequency, interval, days for weekly, until or count). With guests, invitations are ' +
    'emailed to them from the mailbox address unless notify is false; outside guests count against sending limits.',
  input: z.object({ mailboxId: id, ...eventFields }),
  http: { method: 'POST', path: '/calendar/mailboxes/:mailboxId/events', status: 201 },
  run: async ({ env, actor }, { mailboxId, ...input }) => ({
    event: await mailserver.createEvent(env, actor, mailboxId, input),
  }),
})

export const calendarUpdateEvent = defineOperation({
  name: 'calendar_update_event',
  description:
    'Change an event you organize. title, start, end, allDay and timeZone are always sent, as for ' +
      'calendar_create_event; description, location, repeat, guests and calendarId left out stay as they are ' +
      '(an empty guests list removes everyone). scope "series" (default) ' +
    'changes the event, or every occurrence of a repeating one, and its guest list; scope "occurrence" with ' +
    'occurrence (from calendar_list_events) changes only that occurrence\'s title, text and time. Guests are ' +
    'emailed the update unless notify is false. To answer an invitation use calendar_respond_to_event.',
  input: z.object({
    mailboxId: id,
    eventId,
    ...eventFields,
    scope: z.enum(['series', 'occurrence']).default('series'),
    occurrence: localDateTime.optional(),
  }),
  http: { method: 'PATCH', path: '/calendar/mailboxes/:mailboxId/events/:eventId' },
  run: async ({ env, actor }, { mailboxId, eventId, ...input }) => ({
    event: await mailserver.updateEvent(env, actor, mailboxId, eventId, input),
  }),
})

export const calendarDeleteEvent = defineOperation({
  name: 'calendar_delete_event',
  description:
    'Delete an event, or with occurrence only that occurrence of a repeating event. If you organize it, guests ' +
    'are emailed a cancellation unless notify is false. Cannot be undone.',
  input: z.object({ mailboxId: id, eventId, occurrence: localDateTime.optional(), notify: flag.optional() }),
  http: { method: 'DELETE', path: '/calendar/mailboxes/:mailboxId/events/:eventId' },
  mcp: { destructive: true },
  run: ({ env, actor }, { mailboxId, eventId, ...options }) =>
    mailserver.deleteEvent(env, actor, mailboxId, eventId, options),
})

export const calendarRespondToEvent = defineOperation({
  name: 'calendar_respond_to_event',
  description:
    'Answer an invitation in a mailbox calendar: accepted, tentative (maybe) or declined. The organizer is emailed ' +
    'the answer. Applies to every occurrence of a repeating event.',
  input: z.object({ mailboxId: id, eventId, status: z.enum(['accepted', 'tentative', 'declined']) }),
  http: { method: 'POST', path: '/calendar/mailboxes/:mailboxId/events/:eventId/rsvp' },
  run: async ({ env, actor }, input) => ({
    event: await mailserver.respondToEvent(env, actor, input.mailboxId, input.eventId, input.status),
  }),
})

const blobId = z.string().min(1).max(256)

export const calendarGetInvite = defineOperation({
  name: 'calendar_get_invite',
  description:
    "Read the calendar invitation in an email's text/calendar attachment (blobId from email_get_thread): method " +
    '(request = an invite or update, reply = a guest answered, cancel), the event as the email describes it, ' +
    "your calendar's copy if it's there (existing), whether the email is newer than that copy (outdated), and for " +
    'a reply who answered and how.',
  input: z.object({ mailboxId: id, blobId }),
  http: { method: 'GET', path: '/calendar/mailboxes/:mailboxId/invites/:blobId' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({ invite: await mailserver.getInvite(env, actor, input.mailboxId, input.blobId) }),
})

export const calendarApplyInvite = defineOperation({
  name: 'calendar_apply_invite',
  description:
    'Act on the calendar invitation in an email. For an invite: adds it to your calendar if missing, updates your ' +
    'copy if the email is newer, and with status (accepted, tentative, declined) emails your answer to the ' +
    'organizer. For a cancellation: removes it from your calendar. Returns your copy (event), or null once removed.',
  input: z.object({ mailboxId: id, blobId, status: z.enum(['accepted', 'tentative', 'declined']).optional() }),
  http: { method: 'POST', path: '/calendar/mailboxes/:mailboxId/invites/:blobId' },
  run: async ({ env, actor }, input) => ({
    event: await mailserver.applyInvite(env, actor, input.mailboxId, input.blobId, input.status),
  }),
})

export const calendarOperations = [
  calendarListCalendars,
  calendarListEvents,
  calendarGetEvent,
  calendarCreateEvent,
  calendarUpdateEvent,
  calendarDeleteEvent,
  calendarRespondToEvent,
  calendarGetInvite,
  calendarApplyInvite,
]
