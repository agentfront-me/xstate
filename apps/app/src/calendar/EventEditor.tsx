// Creating or editing an event, in the same side panel (the design has no editor of its own; see
// docs/calendar-plan.md). Times are entered in the event's own time zone: yours for new events.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { ApiError, errorMessage, isEmail } from '../lib/core'
import { RecipientInput } from '../mail/RecipientInput'
import { addDays, type Calendar, type CalendarEvent, type EventInput, localDate, localDateTime, localZone, type Scope, type Weekday } from './api'

type RepeatChoice = 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'yearly'

export type Draft = {
  title: string
  allDay: boolean
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  calendarId: string
  repeat: RepeatChoice
  location: string
  guests: string
  description: string
}

const WEEKDAYS: Weekday[] = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa']

/** A draft for a new event over a picked range, or the next whole hour for an hour. */
export function newDraft(calendarId: string, range?: { start: Date; end: Date; allDay: boolean }): Draft {
  let start = range?.start
  let end = range?.end
  if (!start || !end) {
    start = new Date()
    start.setMinutes(0, 0, 0)
    start.setHours(start.getHours() + 1)
    end = new Date(start.getTime() + 3600000)
  }
  const allDay = range?.allDay ?? false
  // A picked all-day range ends the day after its last day (or on the clicked day itself in Month view).
  const lastDay = allDay ? (end > start ? addDays(localDate(end), -1) : localDate(start)) : localDate(end)
  const s = localDateTime(start)
  const e = localDateTime(end)
  return {
    title: '',
    allDay,
    startDate: s.slice(0, 10),
    startTime: allDay ? '09:00' : s.slice(11),
    endDate: lastDay,
    endTime: allDay ? '10:00' : e.slice(11),
    calendarId,
    repeat: 'none',
    location: '',
    guests: '',
    description: '',
  }
}

export function draftOf(event: CalendarEvent): Draft {
  const repeat: RepeatChoice = !event.repeat
    ? 'none'
    : event.repeat.frequency === 'weekly' && event.repeat.days.join(',') === 'mo,tu,we,th,fr'
      ? 'weekdays'
      : event.repeat.frequency
  return {
    title: event.title,
    allDay: event.allDay,
    startDate: event.localStart.slice(0, 10),
    startTime: event.allDay ? '09:00' : event.localStart.slice(11, 16),
    endDate: event.localEnd.slice(0, 10),
    endTime: event.allDay ? '10:00' : event.localEnd.slice(11, 16),
    calendarId: event.calendarId,
    repeat,
    location: event.location,
    guests: event.guests.filter((g) => !g.organizer).map((g) => g.email).join(', '),
    description: event.description,
  }
}

function toInput(d: Draft, event: CalendarEvent | null): EventInput {
  const emails = d.guests
    .split(/[,;\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  const bad = emails.filter((x) => !isEmail(x))
  if (bad.length) throw new Error(`Not an email address: ${bad.join(', ')}`)
  const names = new Map(event?.guests.map((g) => [g.email, g.name]) ?? [])
  const startDay = WEEKDAYS[new Date(`${d.startDate}T00:00`).getDay()]!
  const repeat: EventInput['repeat'] =
    d.repeat === 'none'
      ? null
      : d.repeat === 'weekdays'
        ? { frequency: 'weekly', days: ['mo', 'tu', 'we', 'th', 'fr'] }
        : d.repeat === 'weekly'
          ? { frequency: 'weekly', days: event?.repeat?.frequency === 'weekly' && event.repeat.days.length ? event.repeat.days : [startDay] }
          : { frequency: d.repeat, interval: event?.repeat?.frequency === d.repeat ? event.repeat.interval : 1 }
  return {
    calendarId: d.calendarId,
    title: d.title.trim() || 'New event',
    description: d.description,
    location: d.location.trim(),
    allDay: d.allDay,
    start: d.allDay ? d.startDate : `${d.startDate}T${d.startTime}`,
    end: d.allDay ? d.endDate : `${d.endDate}T${d.endTime}`,
    timeZone: d.allDay ? undefined : (event?.timeZone ?? localZone()),
    // Opened from one occurrence, repeat and guests can't be changed here, so leave the series' own alone.
    repeat: event?.occurrence || (event?.repeat && d.repeat !== 'none' && sameRepeat(d.repeat, event)) ? undefined : repeat,
    guests: event?.occurrence ? undefined : emails.map((email) => ({ email, name: names.get(email) ?? null })),
  }
}

/** Leave an unchanged repeat rule alone, so its until / count survive an edit. */
function sameRepeat(choice: RepeatChoice, event: CalendarEvent): boolean {
  return draftOf(event).repeat === choice
}

type Props = {
  event: CalendarEvent | null
  initial: Draft
  calendars: Calendar[]
  orgId: string | null
  onSave: (input: EventInput, scope: Scope) => Promise<void>
  onCancel: () => void
}

export function EventEditor({ event, initial, calendars, orgId, onSave, onCancel }: Props) {
  const [d, setD] = useState<Draft>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [askScope, setAskScope] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((x) => ({ ...x, [key]: value }))
  const zone = event?.timeZone && event.timeZone !== localZone() ? event.timeZone : null
  const occurrence = !!event?.occurrence

  // After the mouse-up that ends a drag on the grid, so the grid doesn't take focus back.
  useEffect(() => {
    const t = setTimeout(() => titleRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [])

  // Moving the start keeps the length; an end before the start follows it.
  const setStartDate = (value: string) =>
    setD((x) => {
      const shift = Math.round((Date.parse(value) - Date.parse(x.startDate)) / 86400000)
      return { ...x, startDate: value, endDate: Number.isFinite(shift) ? addDays(x.endDate, shift) : x.endDate }
    })
  const setStartTime = (value: string) =>
    setD((x) => {
      const before = Date.parse(`${x.startDate}T${x.startTime}`)
      const after = Date.parse(`${x.startDate}T${value}`)
      const end = Date.parse(`${x.endDate}T${x.endTime}`)
      if (!Number.isFinite(before) || !Number.isFinite(after) || !Number.isFinite(end)) return { ...x, startTime: value }
      const next = localDateTime(new Date(end + (after - before)))
      return { ...x, startTime: value, endDate: next.slice(0, 10), endTime: next.slice(11) }
    })

  // Set when the API refused for the invitation limit; Save can then go ahead without emailing guests.
  const [quietScope, setQuietScope] = useState<Scope | null>(null)

  const save = async (scope: Scope, notify = true) => {
    setBusy(true)
    setError('')
    setQuietScope(null)
    try {
      await onSave({ ...toInput(d, event), ...(!notify && { notify: false }) }, scope)
    } catch (err) {
      setError(errorMessage(err))
      if (err instanceof ApiError && err.code === 'invite_limit_reached') setQuietScope(scope)
      setBusy(false)
    }
  }

  const submit = () => {
    if (occurrence) setAskScope(true)
    else void save('series')
  }

  return (
    <aside className="u-panel c-panel" aria-label={event ? 'Edit event' : 'New event'}>
      <form
        className="c-editor"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => {
          // Escape on an open menu only closes the menu.
          if (e.key === 'Escape' && !(e.target instanceof HTMLSelectElement)) onCancel()
        }}
      >
        <div className="c-panel-tools">
          <span className="grow small muted">{event ? 'Edit event' : 'New event'}</span>
          <button type="button" className="ghost" title="Close" aria-label="Close" onClick={onCancel}>
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="u-panel-scroll c-panel-body">
          <input
            ref={titleRef}
            className="c-title-input"
            placeholder="Add a title"
            aria-label="Title"
            value={d.title}
            maxLength={300}
            onChange={(e) => set('title', e.target.value)}
          />

          <label className="c-check">
            <input type="checkbox" checked={d.allDay} onChange={(e) => set('allDay', e.target.checked)} />
            All day
          </label>

          <div className={`c-when-grid${d.allDay ? ' is-all-day' : ''}`}>
            <span className="muted small">Starts</span>
            <input type="date" aria-label="Start date" value={d.startDate} required onChange={(e) => setStartDate(e.target.value)} />
            {!d.allDay && <input type="time" aria-label="Start time" value={d.startTime} required onChange={(e) => setStartTime(e.target.value)} />}
            <span className="muted small">Ends</span>
            <input type="date" aria-label="End date" value={d.endDate} required onChange={(e) => set('endDate', e.target.value)} />
            {!d.allDay && <input type="time" aria-label="End time" value={d.endTime} required onChange={(e) => set('endTime', e.target.value)} />}
          </div>
          {zone && !d.allDay && <p className="small dim">Times are in {zone.replace(/_/g, ' ')}.</p>}

          <div className="c-fields">
            <label className="c-field">
              <Icon name="calendar" size={15} />
              <select aria-label="Calendar" value={d.calendarId} disabled={occurrence} onChange={(e) => set('calendarId', e.target.value)}>
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="c-field">
              <Icon name="repeat" size={15} />
              <select aria-label="Repeat" value={d.repeat} disabled={occurrence} onChange={(e) => set('repeat', e.target.value as RepeatChoice)}>
                <option value="none">Does not repeat</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="weekdays">Every weekday</option>
                <option value="monthly">Every month</option>
                <option value="yearly">Every year</option>
              </select>
            </label>
            <label className="c-field">
              <Icon name="map-pin" size={15} />
              <input placeholder="Add a location" aria-label="Location" value={d.location} maxLength={500} onChange={(e) => set('location', e.target.value)} />
            </label>
            <div className="c-field">
              <Icon name="users" size={15} />
              {occurrence ? (
                <span className="small muted">Guests are the same for every event in the series.</span>
              ) : (
                <RecipientInput id="c-guests" value={d.guests} onChange={(v) => set('guests', v)} orgId={orgId} placeholder="Add guests" />
              )}
            </div>
            <label className="c-field is-top">
              <Icon name="align-left" size={15} />
              <textarea placeholder="Add a description" aria-label="Description" rows={4} value={d.description} onChange={(e) => set('description', e.target.value)} />
            </label>
          </div>
          {d.guests.trim() && !occurrence && <p className="small dim">Guests get an email invitation when you save.</p>}
          {error && (
            <div className="c-error small">
              <p>{error}</p>
              {quietScope && (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save(quietScope, false)}>
                  Save without emailing guests
                </button>
              )}
            </div>
          )}
        </div>

        <div className="c-panel-foot">
          {askScope ? (
            <>
              <span className="small muted grow">Change which events?</span>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save('occurrence')}>
                This event
              </button>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save('series')}>
                All events
              </button>
            </>
          ) : (
            <>
              <span className="grow" />
              <button type="button" className="btn btn-sm btn-quiet" onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
                {busy && <span className="spinner" />}
                Save
              </button>
            </>
          )}
        </div>
      </form>
    </aside>
  )
}
