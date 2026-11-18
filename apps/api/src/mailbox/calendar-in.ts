// What an invitation email that reached a store-held mailbox should do to its calendar (docs/mailbox-store-plan.md,
// phase 3c, the table there): a guest's answer, an update or cancellation from the organizer, or a new invitation
// from someone known. Every refusal has a reason for the delivery log. ./calendar-apply.ts carries the decision out.
// Pure: no runtime imports, so `pnpm test` runs it under Node.

import { mailto } from '../mailserver/calendar-events.ts'
import type { StoredEvent } from '../mailserver/calendar-types'
import type { ParsedCalendar } from './ical-in.ts'

export type IncomingContext = {
  /** The From address, lowercase. */
  from: string
  /** SES proved the From domain (./sender-auth.ts). */
  proven: boolean
  /** The sender would reach the Inbox under spam layer 3: same organization, written to, or a contact. */
  known: boolean
  /** The message is in Junk. */
  junk: boolean
  /** This mailbox's addresses, lowercase. */
  own: string[]
}

export type Decision =
  | { action: 'answer'; email: string; status: string; occurrences: string[] }
  | { action: 'update'; whole: boolean; occurrences: string[] }
  | { action: 'add' }
  | { action: 'cancel'; occurrences: string[] }
  | { action: 'skip'; reason: SkipReason }

export type SkipReason =
  | 'junk'
  | 'not_an_itip_method'
  | 'not_authenticated'
  | 'unknown_event'
  | 'not_our_event'
  | 'own_event'
  | 'not_a_guest'
  | 'not_from_guest'
  | 'not_organizer'
  | 'older_sequence'
  | 'unknown_sender'
  | 'not_invited'
  | 'no_answer'

/** What to do with this file, given our copy of the event (matched by UID; null when we have none). */
export function decide(file: ParsedCalendar, existing: StoredEvent | null, ctx: IncomingContext): Decision {
  if (ctx.junk) return skip('junk')
  if (file.method === 'other') return skip('not_an_itip_method')
  const occurrences = Object.keys(file.occurrences)
  const sample = file.event ?? Object.values(file.occurrences)[0] ?? null
  if (!sample) return skip('unknown_event')

  if (file.method === 'reply') {
    if (!existing) return skip('unknown_event')
    if (!isOwn(organizerOf(existing), ctx.own)) return skip('not_our_event')
    const answer = Object.values(sample.participants ?? {}).find((p) => !p.roles?.owner && mailto(p.calendarAddress))
    const email = mailto(answer?.calendarAddress)
    if (!email || !answer?.participationStatus) return skip('no_answer')
    if (email !== ctx.from) return skip('not_from_guest')
    if (!guestsOf(existing).includes(email)) return skip('not_a_guest')
    if (!ctx.proven) return skip('not_authenticated')
    return { action: 'answer', email, status: answer.participationStatus, occurrences: file.event ? [] : occurrences }
  }

  const organizer = organizerOf(sample)
  if (organizer && isOwn(organizer, ctx.own)) return skip('own_event')
  if (!organizer || organizer !== ctx.from) return skip('not_organizer')

  if (file.method === 'cancel') {
    if (!existing) return skip('unknown_event')
    if (organizerOf(existing) !== organizer) return skip('not_organizer')
    if (!ctx.proven) return skip('not_authenticated')
    return { action: 'cancel', occurrences: file.event ? [] : occurrences }
  }

  // request
  if (existing) {
    if (organizerOf(existing) !== organizer) return skip('not_organizer')
    if ((sample.sequence ?? 0) < (existing.sequence ?? 0)) return skip('older_sequence')
    if (!ctx.proven) return skip('not_authenticated')
    return { action: 'update', whole: !!file.event, occurrences }
  }
  if (!file.event) return skip('unknown_event')
  if (!guestsOf(file.event).some((g) => isOwn(g, ctx.own))) return skip('not_invited')
  if (!ctx.proven) return skip('not_authenticated')
  if (!ctx.known) return skip('unknown_sender')
  return { action: 'add' }
}

/** Whether the times of an event changed (then a guest's earlier answer no longer stands). */
export function timeMoved(before: StoredEvent, after: StoredEvent): boolean {
  const pick = (e: StoredEvent) => JSON.stringify([e.start, e.duration, e.timeZone ?? null, !!e.showWithoutTime, e.recurrenceRule ?? null])
  return pick(before) !== pick(after)
}

function skip(reason: SkipReason): Decision {
  return { action: 'skip', reason }
}

function organizerOf(e: StoredEvent): string | null {
  return mailto(e.organizerCalendarAddress) ?? mailto(Object.values(e.participants ?? {}).find((p) => p.roles?.owner)?.calendarAddress)
}

function guestsOf(e: StoredEvent): string[] {
  return Object.values(e.participants ?? {})
    .filter((p) => !p.roles?.owner)
    .map((p) => mailto(p.calendarAddress))
    .filter((a): a is string => !!a)
}

function isOwn(address: string | null, own: string[]): boolean {
  return !!address && own.includes(address)
}
