// The readable part of an invitation email (docs/mailbox-store-plan.md, phase 3b): subject, plain text and HTML
// around the iCalendar file from ./ical-out.ts. Times are written in the event's own zone, named, because the
// guests' zones aren't known; their calendar app shows the event in their own. Pure: `pnpm test` runs it.

import { addDays, durationMinutes, mailto, withSeconds, zonedToUtc } from '../mailserver/calendar-events.ts'
import type { JmapEvent } from '../mailserver/stalwart/calendar'
import { cancelledOccurrence } from './calendar-expand.ts'
import type { ItipMethod } from './ical-out.ts'

export type InviteKind = 'invitation' | 'update' | 'cancel' | 'accepted' | 'declined' | 'tentative'

const PREFIX: Record<InviteKind, string> = {
  invitation: 'Invitation',
  update: 'Updated invitation',
  cancel: 'Cancelled',
  accepted: 'Accepted',
  declined: 'Declined',
  tentative: 'Tentative',
}

export function methodOf(kind: InviteKind): ItipMethod {
  return kind === 'invitation' || kind === 'update' ? 'REQUEST' : kind === 'cancel' ? 'CANCEL' : 'REPLY'
}

export type InviteText = { subject: string; text: string; html: string }

/**
 * Subject and body for one invitation email. `occurrence`: a cancellation of that one occurrence. `who`: for an
 * answer, the person answering (shown as "Sam accepted").
 */
export function inviteText(kind: InviteKind, event: JmapEvent, options: { occurrence?: string; who?: { name: string | null; email: string } } = {}): InviteText {
  const shown = options.occurrence ? (cancelledOccurrence(event, options.occurrence) ?? event) : event
  const title = shown.title?.trim() || '(No title)'
  const when = whenText(shown)
  const subject = `${PREFIX[kind]}: ${title} @ ${when}`

  const location = Object.values(shown.locations ?? {})[0]?.name ?? ''
  const people = Object.values(event.participants ?? {})
  const organizer = people.find((p) => p.roles?.owner)
  const guests = people.filter((p) => !p.roles?.owner && mailto(p.calendarAddress))
  const repeat = !options.occurrence && event.recurrenceRule ? repeatText(event) : null
  const who = options.who ? (options.who.name ? `${options.who.name} <${options.who.email}>` : options.who.email) : null

  const lead =
    kind === 'invitation' ? 'You have been invited to this event.'
    : kind === 'update' ? 'This event has been changed.'
    : kind === 'cancel' ? (options.occurrence ? 'This occurrence has been cancelled.' : 'This event has been cancelled.')
    : `${who ?? 'A guest'} ${kind === 'tentative' ? 'tentatively accepted' : kind} this invitation.`

  const rows: [string, string][] = [['When', repeat ? `${when}, ${repeat}` : when]]
  if (location) rows.push(['Where', location])
  if (organizer) rows.push(['Organizer', person(organizer.name, mailto(organizer.calendarAddress))])
  if (guests.length && kind !== 'accepted' && kind !== 'declined' && kind !== 'tentative') {
    rows.push(['Guests', guests.map((g) => person(g.name, mailto(g.calendarAddress))).join(', ')])
  }
  const description = kind === 'cancel' || kind === 'accepted' || kind === 'declined' || kind === 'tentative' ? '' : (shown.description ?? '').trim()
  const footer = methodOf(kind) === 'REQUEST' ? 'Answer from your calendar app, or with the buttons your email app shows for this invitation.' : ''

  const text = [lead, '', title, ...rows.map(([k, v]) => `${k}: ${v}`), ...(description ? ['', description] : []), ...(footer ? ['', footer] : [])].join('\n')
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">',
    `<p style="margin:0 0 12px;color:#555">${esc(lead)}</p>`,
    `<h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>`,
    '<table style="border-collapse:collapse">',
    ...rows.map(([k, v]) => `<tr><td style="padding:2px 16px 2px 0;color:#777;vertical-align:top">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`),
    '</table>',
    description ? `<p style="margin:16px 0 0;white-space:pre-wrap">${esc(description)}</p>` : '',
    footer ? `<p style="margin:16px 0 0;color:#777;font-size:12px">${esc(footer)}</p>` : '',
    '</div>',
  ].join('\n')
  return { subject, text, html }
}

/** "Thu 19 Nov 2026 3pm – 3:30pm (GMT+5)", "Thu 19 Nov 2026" or "Thu 24 Dec – Fri 25 Dec 2026" for all-day. */
export function whenText(e: JmapEvent): string {
  const minutes = durationMinutes(e.duration ?? (e.showWithoutTime ? 'P1D' : 'PT0S'))
  if (e.showWithoutTime) {
    const first = e.start.slice(0, 10)
    const last = addDays(first, Math.max(1, Math.round(minutes / 1440)) - 1)
    const day = (d: string) => fmt(Date.parse(`${d}T12:00:00Z`), 'UTC', { weekday: 'short', day: 'numeric', month: 'short' })
    const year = first.slice(0, 4)
    return first === last ? `${day(first)} ${year}` : `${day(first)} – ${day(last)} ${last.slice(0, 4)}`
  }
  const zone = e.timeZone ?? 'UTC'
  const start = Date.parse(e.timeZone ? zonedToUtc(e.start, zone) : `${withSeconds(e.start)}Z`)
  const end = start + minutes * 60_000
  const date = (t: number) => fmt(t, zone, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const time = (t: number) => fmt(t, zone, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(':00', '').replace(/\s?([AP]M)/i, (_, m: string) => m.toLowerCase())
  const zoneName = fmt(start, zone, { timeZoneName: 'short' }).split(' ').pop()
  const sameDay = date(start) === date(end) || minutes === 0
  return sameDay ? `${date(start)} ${time(start)} – ${time(end)} (${zoneName})` : `${date(start)} ${time(start)} – ${date(end)} ${time(end)} (${zoneName})`
}

function repeatText(e: JmapEvent): string {
  const rule = (e.recurrenceRule ?? {}) as { frequency?: string; interval?: number; count?: number; until?: string }
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[rule.frequency ?? ''] ?? 'time'
  const every = rule.interval && rule.interval > 1 ? `every ${rule.interval} ${unit}s` : `every ${unit}`
  if (rule.count) return `${every}, ${rule.count} times`
  if (rule.until) return `${every} until ${fmt(Date.parse(`${rule.until.slice(0, 10)}T12:00:00Z`), 'UTC', { day: 'numeric', month: 'short', year: 'numeric' })}`
  return every
}

function fmt(ms: number, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(new Date(ms)).replace(',', '')
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(new Date(ms)).replace(',', '')
  }
}

function person(name: string | null | undefined, email: string | null): string {
  return name ? `${name} <${email ?? ''}>` : (email ?? '')
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
