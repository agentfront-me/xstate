// What a change to an event kept in a mailbox's store means for whom (docs/mailbox-store-plan.md, phase 3b): the
// invitations, updates, cancellations and answers to email (RFC 6047 iMIP).
// ./invite-send.ts sends them. Pure: no runtime imports, so `pnpm test` runs it under Node.

import { mailto } from '../mailserver/calendar-events.ts'
import type { StoredEvent, StoredParticipant } from '../mailserver/calendar-types'
import type { InviteKind } from './invite-mail.ts'

export type InviteEmail = {
  kind: InviteKind
  /** The event as it now is (as it was, for a cancellation). */
  event: StoredEvent
  to: string[]
  /** A cancellation of one occurrence: its original local start. */
  occurrence?: string
}

/**
 * The emails a change calls for, in order. `before` null: the event was just made; `after` null: it was deleted.
 * `own`: this mailbox's addresses. Organizer: guests removed get a cancellation, deleted occurrences one each, new
 * guests an invitation, the others an update when something they were told changed. Guest: the organizer gets the
 * new answer.
 */
export function scheduling(before: StoredEvent | null, after: StoredEvent | null, own: string[]): InviteEmail[] {
  const event = after ?? before
  if (!event) return []
  const organizer = organizerOf(event)
  const mine = (address: string | null) => !!address && own.includes(address)

  // A guest's change: only their own answer is news, for the organizer.
  if (organizer && !mine(organizer)) {
    if (!after) return []
    const was = before ? statusOf(before, own) : 'needs-action'
    const now = statusOf(after, own)
    if (!now || now === was || now === 'needs-action') return []
    return [{ kind: now as InviteKind, event: after, to: [organizer] }]
  }

  const guestsBefore = before ? guestsOf(before, own) : []
  if (!after) return guestsBefore.length ? [{ kind: 'cancel', event: before!, to: guestsBefore }] : []
  const guestsAfter = guestsOf(after, own)
  const out: InviteEmail[] = []
  const removed = guestsBefore.filter((g) => !guestsAfter.includes(g))
  if (removed.length) out.push({ kind: 'cancel', event: before!, to: removed })
  if (!before) return guestsAfter.length ? [...out, { kind: 'invitation', event: after, to: guestsAfter }] : out

  // Occurrences deleted: cancelled one by one. If that is the only change, nothing else is sent.
  const newlyExcluded = Object.entries(after.recurrenceOverrides ?? {})
    .filter(([key, change]) => (change as Record<string, unknown>).excluded && !(before.recurrenceOverrides?.[key] as Record<string, unknown> | undefined)?.excluded)
    .map(([key]) => key)
  for (const key of newlyExcluded) if (guestsAfter.length) out.push({ kind: 'cancel', event: after, to: guestsAfter, occurrence: key })

  const added = guestsAfter.filter((g) => !guestsBefore.includes(g))
  const stayed = guestsAfter.filter((g) => guestsBefore.includes(g))
  const otherChange = (after.sequence ?? 0) !== (before.sequence ?? 0) && comparable(before, newlyExcluded) !== comparable(after, newlyExcluded)
  if (added.length) out.push({ kind: 'invitation', event: after, to: added })
  if (otherChange && stayed.length) out.push({ kind: 'update', event: after, to: stayed })
  return out
}

function organizerOf(e: StoredEvent): string | null {
  return mailto(e.organizerCalendarAddress) ?? mailto(Object.values(e.participants ?? {}).find((p) => p.roles?.owner)?.calendarAddress)
}

export function participantOf(e: StoredEvent, own: string[]): StoredParticipant | null {
  return Object.values(e.participants ?? {}).find((p) => own.includes(mailto(p.calendarAddress) ?? '')) ?? null
}

function statusOf(e: StoredEvent, own: string[]): string | null {
  return participantOf(e, own)?.participationStatus ?? null
}

/** Everyone on the event except its organizer and this mailbox. */
function guestsOf(e: StoredEvent, own: string[]): string[] {
  return Object.values(e.participants ?? {})
    .filter((p) => !p.roles?.owner)
    .map((p) => mailto(p.calendarAddress))
    .filter((a): a is string => !!a && !own.includes(a))
}

/** The event as guests see it, without bookkeeping, answers or the occurrences just cancelled, for spotting a real change. */
function comparable(e: StoredEvent, ignoreExcluded: string[]): string {
  const { sequence: _s, updated: _u, participants, recurrenceOverrides, ...rest } = e as StoredEvent & { created?: string }
  delete (rest as Record<string, unknown>).created
  const people = Object.values(participants ?? {})
    .map((p) => `${mailto(p.calendarAddress)}:${p.roles?.optional ? 'o' : ''}`)
    .sort()
  const overrides = Object.fromEntries(Object.entries(recurrenceOverrides ?? {}).filter(([key]) => !ignoreExcluded.includes(key)))
  return stable([rest, people, overrides])
}

/** JSON with object keys sorted, so two versions of an event compare equal however their keys were ordered. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
