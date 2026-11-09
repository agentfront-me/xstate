// The event panel over the right of the grid (design: Calendar → event click): calendar, location, description and
// guests with their answers. Guests answer here; the organizer edits or deletes. Repeating events ask whether a
// change is for this occurrence or all of them.

import { useState } from 'react'
import { Icon } from '../components/Icon'
import { errorMessage, initials } from '../lib/core'
import type { Calendar, CalendarEvent, GuestStatus, Scope } from './api'
import { statusLabel, whenLabel } from './format'

type Props = {
  event: CalendarEvent
  calendars: Calendar[]
  onEdit: () => void
  onDelete: (scope: Scope) => Promise<void>
  onRespond: (status: Exclude<GuestStatus, 'needs-action'>) => Promise<void>
  onClose: () => void
}

const REPEAT_LABEL: Record<string, string> = { daily: 'Every day', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' }
const UNITS: Record<string, string> = { daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' }
const DAY_NAMES: Record<string, string> = { mo: 'Mon', tu: 'Tue', we: 'Wed', th: 'Thu', fr: 'Fri', sa: 'Sat', su: 'Sun' }

export function repeatLabel(repeat: CalendarEvent['repeat']): string | null {
  if (!repeat) return null
  const days = repeat.days.join(',')
  if (repeat.frequency === 'weekly' && days === 'mo,tu,we,th,fr') return 'Every weekday'
  let text = REPEAT_LABEL[repeat.frequency] ?? 'Repeats'
  if (repeat.interval > 1) text = `Every ${repeat.interval} ${UNITS[repeat.frequency]}`
  if (repeat.frequency === 'weekly' && repeat.days.length) text += ` on ${repeat.days.map((d) => DAY_NAMES[d]).join(', ')}`
  if (repeat.until) text += `, until ${new Date(`${repeat.until}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
  else if (repeat.count) text += `, ${repeat.count} times`
  return text
}

export function EventPanel({ event, calendars, onEdit, onDelete, onRespond, onClose }: Props) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const calendar = calendars.find((c) => c.id === event.calendarId)
  const repeats = !!(event.repeat || event.seriesId)
  const cancelled = event.status === 'cancelled'
  const others = event.guests.filter((g) => !g.organizer)

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="u-panel c-panel" aria-label="Event">
      <div className="c-panel-tools">
        {event.isOrganizer && !cancelled && (
          <button className="ghost" title="Edit" aria-label="Edit" onClick={onEdit}>
            <Icon name="pencil" size={15} />
          </button>
        )}
        <button className="ghost" title="Delete" aria-label="Delete" onClick={() => setConfirming(true)}>
          <Icon name="trash" size={15} />
        </button>
        <button className="ghost" title="Close" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={15} />
        </button>
      </div>

      <div className="u-panel-scroll c-panel-body">
        <div className="c-panel-title">
          <span className={`c-mark${calendar?.isDefault ? ' is-main' : ''}`} />
          <div className="grow">
            <h2 className={`hi c-title${cancelled ? ' is-cancelled' : ''}`}>{event.title || '(No title)'}</h2>
            <p className="muted c-when">{whenLabel(event)}</p>
          </div>
        </div>

        {cancelled && (
          <p className="c-note">
            <Icon name="circle-alert" size={14} />
            {event.organizer ?? 'The organizer'} cancelled this event.
          </p>
        )}

        <ul className="c-facts">
          {calendar && (
            <li>
              <Icon name="calendar" size={15} />
              <span>{calendar.name}</span>
            </li>
          )}
          {repeatLabel(event.repeat) && (
            <li>
              <Icon name="repeat" size={15} />
              <span>{repeatLabel(event.repeat)}</span>
            </li>
          )}
          {event.location && (
            <li>
              <Icon name="map-pin" size={15} />
              <span className="c-wrap">{event.location}</span>
            </li>
          )}
          {event.description && (
            <li>
              <Icon name="align-left" size={15} />
              <span className="c-wrap c-desc">{event.description}</span>
            </li>
          )}
          {event.guests.length > 0 && (
            <li className="c-guests">
              <Icon name="users" size={15} />
              <div className="grow">
                <span>
                  {event.guests.length} {event.guests.length === 1 ? 'guest' : 'guests'}
                </span>
                <ul>
                  {event.guests.map((g) => (
                    <li key={g.email}>
                      <span className="u-avatar c-avatar">{initials(g.name || g.email)[0]}</span>
                      <span className="ellipsis grow hi" title={g.email}>
                        {g.name || g.email}
                      </span>
                      <span className="small muted">{g.organizer ? 'Organizer' : statusLabel[g.status]}</span>
                    </li>
                  ))}
                </ul>
                {event.isOrganizer && others.length > 0 && (
                  <span className="small dim">
                    {others.filter((g) => g.status === 'accepted').length} of {others.length} accepted
                  </span>
                )}
              </div>
            </li>
          )}
        </ul>

        {event.myStatus && !cancelled && (
          <div className="c-rsvp">
            <span className="muted small">Going?</span>
            <div className="seg" role="group" aria-label="Your answer">
              {(['accepted', 'tentative', 'declined'] as const).map((s) => (
                <button key={s} aria-pressed={event.myStatus === s} disabled={busy} onClick={() => void run(() => onRespond(s))}>
                  {s === 'accepted' ? 'Yes' : s === 'tentative' ? 'Maybe' : 'No'}
                </button>
              ))}
            </div>
          </div>
        )}

        {confirming && (
          <div className="c-confirm">
            <p className="hi">{repeats ? 'Delete a repeating event' : 'Delete this event?'}</p>
            <p className="muted small">
              {event.isOrganizer && others.length > 0 && !cancelled
                ? 'Guests get an email saying it was cancelled.'
                : !event.isOrganizer && !cancelled
                  ? 'It is removed from your calendar only. To tell the organizer, answer No instead.'
                  : 'This cannot be undone.'}
            </p>
            <div className="row-gap">
              <button className="btn btn-sm btn-quiet" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
              {repeats && event.occurrence && (
                <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => onDelete('occurrence'))}>
                  This event
                </button>
              )}
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(() => onDelete('series'))}>
                {busy && <span className="spinner" />}
                {repeats ? 'All events' : 'Delete'}
              </button>
            </div>
          </div>
        )}
        {error && <p className="c-error small">{error}</p>}
      </div>
    </aside>
  )
}
