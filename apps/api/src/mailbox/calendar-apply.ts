// Applying invitation emails received by a store-held mailbox to its calendar (docs/mailbox-store-plan.md, phase 3c).
// Called from the mail-events queue (./events.ts) after delivery, for received messages that carry a calendar part:
// the file is read (./ical-in.ts), our copy found by UID, the sender's From checked against SES's results
// (./sender-auth.ts), and ./calendar-in.ts decides. Nothing is emailed from here: answering stays the person's
// choice. Every outcome, applied or skipped and why, is a `calendar` line in the delivery log.

import type { MailboxRow } from '../db/mailboxes'
import * as orgsDb from '../db/organizations'
import { mailto } from '../mailserver/calendar-events'
import type { StoredEvent } from '../mailserver/calendar-types'
import type { EmailEnv } from '../mailserver/types'
import { decide, timeMoved, type Decision } from './calendar-in'
import { ownAddresses, storeCalendars } from './calendar-store'
import { overrideOf, parseIcs } from './ical-in'
import { decodePart } from './mime'
import type { ParsedMessage } from './parse'
import { headerLines, proveSender } from './sender-auth'
import type { StoreEventRow } from './store'
import { store } from './stub'

type Env = EmailEnv & Pick<globalThis.Env, 'AUDIENCE'>

/** The fields an organizer's update replaces; the calendar it sits in and its id stay ours. */
const ORGANIZER_FIELDS = ['title', 'description', 'start', 'duration', 'timeZone', 'showWithoutTime', 'locations', 'status', 'recurrenceRule', 'recurrenceOverrides', 'organizerCalendarAddress', 'sequence'] as const

/** Applies the message's calendar part, if it has one. Returns the decision (for the queue's log), or null. */
export async function applyCalendarMail(env: Env, mailbox: MailboxRow, row: StoreEventRow, raw: Uint8Array, parsed: ParsedMessage): Promise<Decision | null> {
  const part = parsed.parts.find((p) => p.type === 'text/calendar') ?? parsed.parts.find((p) => p.type === 'application/ics' || /\.ics$/i.test(p.name ?? ''))
  if (!part) return null
  const file = parseIcs(new TextDecoder().decode(decodePart(raw.subarray(part.start, part.start + part.length), part.encoding)))
  if (!file) return null

  const stub = await store(env, mailbox.id)
  const cal = await storeCalendars(env, mailbox)
  const own = ownAddresses(mailbox)
  const from = (parsed.from[0]?.email ?? '').toLowerCase()
  const existingId = await cal.findByUid(file.uid)
  const existing = existingId ? await cal.getEvent(existingId) : null
  const proof = proveSender(headerLines(raw), from)
  const decision = decide(file, existing, {
    from,
    proven: proof.proven,
    known: await knownSender(env, mailbox, from),
    junk: row.folder === 'junk',
    own,
  })

  let eventId = existingId
  if (decision.action === 'answer') {
    const series = existing!
    const key = Object.entries(series.participants ?? {}).find(([, p]) => mailto(p.calendarAddress) === decision.email)![0]
    if (!decision.occurrences.length) {
      await cal.updateEvent(series.id, { [`participants/${key}/participationStatus`]: decision.status }, false)
    } else {
      const overrides = { ...(series.recurrenceOverrides ?? {}) }
      for (const occurrence of decision.occurrences) {
        const current = (overrides[occurrence] ?? {}) as Record<string, unknown>
        const people = structuredClone((current.participants as StoredEvent['participants']) ?? series.participants ?? {})
        if (people[key]) people[key] = { ...people[key], participationStatus: decision.status }
        overrides[occurrence] = { ...current, participants: people }
      }
      await cal.updateEvent(series.id, { recurrenceOverrides: overrides, sequence: series.sequence ?? 0 }, false)
    }
  } else if (decision.action === 'update') {
    const series = existing!
    if (decision.whole) {
      const next = file.event!
      const patch: Record<string, unknown> = Object.fromEntries(ORGANIZER_FIELDS.map((f) => [f, next[f] ?? null]))
      patch.participants = keepOwnAnswer(series, next, own, timeMoved(series, next))
      await cal.updateEvent(series.id, patch, false)
    } else {
      const overrides = { ...(series.recurrenceOverrides ?? {}) }
      for (const [key, o] of Object.entries(file.occurrences)) overrides[key] = overrideOf(series, o)
      await cal.updateEvent(series.id, { recurrenceOverrides: overrides, sequence: Math.max(series.sequence ?? 0, ...Object.values(file.occurrences).map((o) => o.sequence ?? 0)) }, false)
    }
  } else if (decision.action === 'cancel') {
    const series = existing!
    const sequence = Math.max(series.sequence ?? 0, file.event?.sequence ?? 0, ...Object.values(file.occurrences).map((o) => o.sequence ?? 0))
    if (!decision.occurrences.length) {
      await cal.updateEvent(series.id, { status: 'cancelled', sequence }, false)
    } else {
      const overrides = { ...(series.recurrenceOverrides ?? {}) }
      for (const key of decision.occurrences) overrides[key] = { ...((overrides[key] ?? {}) as Record<string, unknown>), status: 'cancelled' }
      await cal.updateEvent(series.id, { recurrenceOverrides: overrides, sequence }, false)
    }
  } else if (decision.action === 'add') {
    const calendars = await cal.setUp()
    const calendarId = (calendars.find((c) => c.isDefault) ?? calendars[0])!.id
    const { id: _id, calendarIds: _c, ...fields } = file.event!
    eventId = await cal.createEvent({ ...fields, calendarIds: { [calendarId]: true } }, false)
  }

  await stub.logDelivery([
    {
      step: 'calendar',
      emailId: row.id,
      address: from || null,
      detail: {
        uid: file.uid,
        method: file.method,
        action: decision.action,
        ...(decision.action === 'skip' && { reason: decision.reason }),
        ...(decision.action === 'answer' && { status: decision.status }),
        ...('occurrences' in decision && decision.occurrences.length > 0 && { occurrences: decision.occurrences }),
        ...(eventId && { eventId }),
        proof: proof.how ?? proof.reason,
      },
    },
  ])
  return decision
}

/**
 * The participants from the organizer's update, with this mailbox's own answer carried over, unless the time moved:
 * then it is back to "needs action", as Google does.
 */
function keepOwnAnswer(before: StoredEvent, after: StoredEvent, own: string[], moved: boolean): StoredEvent['participants'] {
  const people = structuredClone(after.participants ?? {})
  if (moved) return people
  const mine = Object.values(before.participants ?? {}).find((p) => own.includes(mailto(p.calendarAddress) ?? ''))
  if (!mine?.participationStatus) return people
  for (const p of Object.values(people)) if (own.includes(mailto(p.calendarAddress) ?? '')) p.participationStatus = mine.participationStatus
  return people
}

/** Spam layer 3's "known": the organization's own domain, someone the mailbox has written to, or a contact. */
async function knownSender(env: Env, mailbox: MailboxRow, from: string): Promise<boolean> {
  if (!from) return false
  const domain = from.slice(from.lastIndexOf('@') + 1)
  const identity = await orgsDb.identity(env.DB, mailbox.organization_id)
  if (identity.domains.map((d) => d.toLowerCase()).includes(domain)) return true
  if ((await (await store(env, mailbox.id)).standing(from)).wrote) return true
  const known = await env.AUDIENCE.get(env.AUDIENCE.idFromName(mailbox.organization_id))
    .knows([from])
    .catch(() => [])
  return known.length > 0
}
