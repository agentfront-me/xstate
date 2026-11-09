// The calendar card above an invitation email (Phase 3 of docs/calendar-plan.md): what the invite is, whether
// it's in your calendar, and Yes / Maybe / No. Also shows updates, cancellations and guests' answers. Invites from
// other xstate mailboxes are already in your calendar; ones from outside are added from here.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { inviteApi, type CalendarEvent, type GuestStatus } from '../calendar/api'
import { statusLabel, whenLabel } from '../calendar/format'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { errorMessage } from '../lib/core'
import type { Attachment } from '../lib/types'

type Answer = Exclude<GuestStatus, 'needs-action'>

/** The part of a message that carries the invitation, if any: the text/calendar part, else an .ics file. */
export function invitePart(attachments: Attachment[]): Attachment | null {
  return (
    attachments.find((a) => a.type.toLowerCase().startsWith('text/calendar')) ??
    attachments.find((a) => a.type.toLowerCase() === 'application/ics' || a.name.toLowerCase().endsWith('.ics')) ??
    null
  )
}

/** The unnamed text/calendar copy mail clients put next to the readable body; not worth a file chip. */
export const isCalendarBodyPart = (a: Attachment) => a.type.toLowerCase().startsWith('text/calendar') && a.name === 'attachment'

const ANSWERED: Record<Answer, string> = { accepted: "You're going", tentative: 'You answered maybe', declined: 'You declined' }

export function InviteCard({ mailboxId, part }: { mailboxId: string; part: Attachment }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const key = ['calendar', 'invite', mailboxId, part.blobId]
  const query = useQuery({ queryKey: key, queryFn: () => inviteApi.get(mailboxId, part.blobId), staleTime: 30_000, retry: false })
  const [busy, setBusy] = useState<string | null>(null)

  // Not an invitation after all, or the calendar is out of reach: the email reads fine without the card.
  if (query.isError) return null
  if (!query.data) {
    return (
      <div className="cal-invite is-loading" aria-busy="true">
        <span className="spinner" />
        <span className="muted small">Reading invitation…</span>
      </div>
    )
  }
  const { method, event, existing, outdated, answer } = query.data
  if (method === 'other') return null
  const shown: CalendarEvent = existing && !outdated ? existing : event

  const act = async (label: string, status?: Answer) => {
    setBusy(label)
    try {
      const saved = await inviteApi.apply(mailboxId, part.blobId, status)
      await Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: ['calendar'] })])
      toast(status ? ANSWERED[status] : saved ? (existing ? 'Calendar updated' : 'Added to your calendar') : 'Removed from your calendar')
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const open = (e: CalendarEvent) =>
    void navigate({ to: '/calendar', search: { date: e.allDay ? e.start : e.start.slice(0, 10), event: e.seriesId ?? e.id } })

  let note: string
  if (method === 'cancel') note = existing ? 'The organizer cancelled this event.' : 'Cancelled. It isn’t in your calendar.'
  else if (method === 'reply') note = answer ? `${answer.name || answer.email} ${replyVerb(answer.status)}` : 'A guest answered.'
  else if (shown.isOrganizer) note = 'You organize this event.'
  else if (!existing) note = 'Not in your calendar yet.'
  else if (outdated) note = 'The organizer changed this event since you added it.'
  else note = existing.myStatus && existing.myStatus !== 'needs-action' ? ANSWERED[existing.myStatus as Answer] : 'In your calendar.'

  const myStatus = existing?.myStatus ?? null
  const canAnswer = method === 'request' && !shown.isOrganizer && (existing ? existing.myStatus !== null : event.myStatus !== null)

  return (
    <section className={`cal-invite${method === 'cancel' ? ' is-cancelled' : ''}`} aria-label="Calendar invitation">
      <span className="cal-invite-icon">
        <Icon name="calendar" size={16} />
      </span>
      <div className="cal-invite-main">
        <div className="cal-invite-title hi">{shown.title || '(No title)'}</div>
        <div className="cal-invite-when">{whenLabel(shown)}</div>
        {shown.location && <div className="cal-invite-where muted small ellipsis">{shown.location}</div>}
        {!shown.isOrganizer && shown.organizer && <div className="muted small">Organizer: {shown.organizer}</div>}
        <div className="cal-invite-note small">{note}</div>
      </div>
      <div className="cal-invite-actions">
        {canAnswer && (
          <div className="seg" role="group" aria-label="Your answer">
            {(['accepted', 'tentative', 'declined'] as const).map((s) => (
              <button key={s} aria-pressed={myStatus === s} disabled={!!busy} onClick={() => void act(s, s)}>
                {busy === s ? <span className="spinner" /> : s === 'accepted' ? 'Yes' : s === 'tentative' ? 'Maybe' : 'No'}
              </button>
            ))}
          </div>
        )}
        <div className="row-gap">
          {method === 'request' && !shown.isOrganizer && !existing && (
            <button className="btn btn-sm" disabled={!!busy} onClick={() => void act('add')}>
              {busy === 'add' && <span className="spinner" />}Add without answering
            </button>
          )}
          {method === 'request' && existing && outdated && (
            <button className="btn btn-sm" disabled={!!busy} onClick={() => void act('update')}>
              {busy === 'update' && <span className="spinner" />}Update my calendar
            </button>
          )}
          {method === 'cancel' && existing && (
            <button className="btn btn-sm" disabled={!!busy} onClick={() => void act('remove')}>
              {busy === 'remove' && <span className="spinner" />}Remove from calendar
            </button>
          )}
          {existing && method !== 'cancel' && (
            <button className="btn btn-sm btn-quiet" onClick={() => open(existing)}>
              Open in Calendar
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

function replyVerb(status: GuestStatus): string {
  if (status === 'accepted') return 'accepted.'
  if (status === 'declined') return 'declined.'
  if (status === 'tentative') return 'answered maybe.'
  return `answered (${statusLabel[status]?.toLowerCase() ?? status}).`
}
