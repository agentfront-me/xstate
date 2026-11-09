// Calendar: follows the Calendar screen of the "xstate App" design. Upcoming events grouped Today / Tomorrow / date
// on the left (clicking one moves the grid there and opens it), a Day / Week / Month grid, and the event panel over
// the right. It shows your own personal mailbox's calendar (Stalwart, via the calendar_* API).

import '../styles/storage.css'
import '../styles/users.css'
import '../styles/calendar.css'
import type { CalendarRef } from '@fullcalendar/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { useAccount } from '../lib/account'
import { readJson, writeJson } from '../lib/core'
import { useFolders } from '../mail/data'
import {
  addDays,
  type CalendarEvent,
  type CalendarSource,
  demoSource,
  type EventInput,
  instant,
  liveSource,
  localDate,
  type Scope,
  seriesIdOf,
} from './api'
import { CalendarGrid, FC_VIEW, selectionKey, type View } from './CalendarGrid'
import { type Draft, draftOf, EventEditor, newDraft } from './EventEditor'
import { EventPanel } from './EventPanel'
import { dayHeading, rangeLabel } from './format'

const VIEW_KEY = 'xstate.calendar-view'
const HIDDEN_KEY = 'xstate.calendar-hidden'
const UPCOMING_DAYS = 30
const UPCOMING_MAX = 40
const POLL_MS = 60_000

type Editing = { event: CalendarEvent | null; draft: Draft }

export function CalendarPage() {
  const account = useAccount()
  const folders = useFolders()
  const demo = account.mode === 'demo'

  // Personal mail (and so its calendar) is readable only by its owner, so the readable personal mailbox is yours.
  const mailboxes = (folders.data ?? []).filter((m) => m.kind === 'personal')
  const mailbox = mailboxes[0] ?? null
  const source = useMemo<CalendarSource | null>(() => (demo ? demoSource() : mailbox ? liveSource(mailbox.mailboxId) : null), [demo, mailbox?.mailboxId])
  const key = demo ? 'demo' : (mailbox?.mailboxId ?? 'none')

  if (!demo && folders.isPending) return <div className="loading" style={{ flex: 1 }}><span className="spinner" /></div>
  if (!source) {
    return (
      <section className="soon">
        <div className="col-head drag"><span className="title">Calendar</span></div>
        <div className="empty">
          <Icon name="calendar" size={28} />
          <strong>No calendar yet</strong>
          <span>Your calendar comes with your personal mailbox. Ask an admin to create one for you in Settings → Domains.</span>
        </div>
      </section>
    )
  }
  return <CalendarScreen key={key} source={source} sourceKey={key} orgId={demo ? null : account.org.id} />
}

function CalendarScreen({ source, sourceKey, orgId }: { source: CalendarSource; sourceKey: string; orgId: string | null }) {
  const client = useQueryClient()
  const gridRef = useRef<CalendarRef>(null)
  const [view, setView] = useState<View>(() => {
    const saved = readJson<View>(VIEW_KEY)
    return saved === 'day' || saved === 'month' ? saved : 'week'
  })
  const [range, setRange] = useState<{ from: Date; to: Date; title: string } | null>(null)
  const [hidden, setHidden] = useState<string[]>(() => readJson<string[]>(HIDDEN_KEY) ?? [])
  const [selected, setSelected] = useState<CalendarEvent | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const today = localDate(new Date())
  const base = ['calendar', sourceKey] as const

  const calendars = useQuery({ queryKey: [...base, 'calendars'], queryFn: () => source.calendars(), staleTime: Infinity })
  const defaultCalendar = calendars.data?.find((c) => c.isDefault) ?? calendars.data?.[0] ?? null

  const from = range?.from.toISOString()
  const to = range?.to.toISOString()
  const events = useQuery({
    queryKey: [...base, 'events', from, to],
    queryFn: () => source.events(from!, to!),
    enabled: !!range && calendars.isSuccess,
    placeholderData: (previous) => previous,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  })
  const upcoming = useQuery({
    queryKey: [...base, 'upcoming', today],
    queryFn: () => source.events(new Date(`${today}T00:00`).toISOString(), new Date(`${addDays(today, UPCOMING_DAYS)}T00:00`).toISOString()),
    enabled: calendars.isSuccess,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  })

  const visible = (e: CalendarEvent) => !hidden.includes(e.calendarId)
  const gridEvents = useMemo(() => (events.data ?? []).filter(visible), [events.data, hidden])
  const groups = useMemo(() => {
    const now = Date.now()
    const list = (upcoming.data ?? [])
      .filter((e) => visible(e) && e.status !== 'cancelled' && instant(e.end) > now)
      .sort((a, b) => instant(a.start) - instant(b.start) || Number(b.allDay) - Number(a.allDay))
      .slice(0, UPCOMING_MAX)
    const byDay = new Map<string, CalendarEvent[]>()
    for (const e of list) {
      const day = e.allDay ? e.start.slice(0, 10) : localDate(new Date(e.start))
      const first = day < today ? today : day
      byDay.set(first, [...(byDay.get(first) ?? []), e])
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [upcoming.data, hidden, today])

  // Keep the open event in step with fresh data (an answer from a guest, an edit elsewhere).
  useEffect(() => {
    if (!selected) return
    const fresh = [...(events.data ?? []), ...(upcoming.data ?? [])].find((e) => e.id === selected.id)
    if (fresh && fresh.updatedAt !== selected.updatedAt) setSelected(fresh)
  }, [events.data, upcoming.data])

  const grid = () => gridRef.current?.getApi()
  const refresh = () => client.invalidateQueries({ queryKey: base })

  const changeView = (next: View) => {
    setView(next)
    writeJson(VIEW_KEY, next)
    grid()?.changeView(FC_VIEW[next])
  }

  const toggleCalendar = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]
    setHidden(next)
    writeJson(HIDDEN_KEY, next.length ? next : null)
  }

  const open = (e: CalendarEvent, move = false) => {
    setEditing(null)
    setSelected(e)
    if (move) {
      const start = new Date(instant(e.start))
      grid()?.gotoDate(start)
      if (!e.allDay && view !== 'month') {
        const hh = String(Math.max(0, start.getHours() - 1)).padStart(2, '0')
        grid()?.scrollToTime(`${hh}:00:00`)
      }
    }
  }

  const startNew = (picked?: { start: Date; end: Date; allDay: boolean }) => {
    if (!defaultCalendar) return
    setSelected(null)
    setEditing({ event: null, draft: newDraft(defaultCalendar.id, picked) })
  }

  const save = async (input: EventInput, scope: Scope) => {
    const event = editing?.event ?? null
    let saved: CalendarEvent
    if (!event) {
      saved = await source.create(input)
      toast(!input.guests?.length ? 'Event created' : input.notify === false ? 'Event created; guests were not emailed' : 'Event created, invitations sent')
    } else {
      // "All events" from one occurrence: keep the series on its own first date, with the new times.
      if (scope === 'series' && event.seriesId) {
        const series = await source.get(event.seriesId)
        const shift = Math.round((instant(series.localStart.slice(0, 10)) - instant(event.localStart.slice(0, 10))) / 86400000)
        const move = (v: string) => `${addDays(v.slice(0, 10), shift)}${v.slice(10)}`
        input = { ...input, start: move(input.start), end: move(input.end) }
      }
      saved = await source.update(event, input, scope)
      // The API answers with the series; keep showing the occurrence that was open.
      if (event.occurrence) {
        const day = input.start.slice(0, 10)
        const near = await source.events(new Date(`${addDays(day, -1)}T00:00`).toISOString(), new Date(`${addDays(day, 2)}T00:00`).toISOString())
        saved = near.find((e) => e.seriesId === seriesIdOf(event) && e.occurrence === event.occurrence) ?? saved
      }
      toast(input.notify === false ? 'Event saved; guests were not emailed' : 'Event saved')
    }
    grid()?.unselect()
    setEditing(null)
    setSelected(saved)
    await refresh()
  }

  const remove = async (scope: Scope) => {
    if (!selected) return
    await source.remove(selected, scope)
    setSelected(null)
    toast(scope === 'occurrence' ? 'Event deleted' : selected.repeat || selected.seriesId ? 'All events deleted' : 'Event deleted')
    await refresh()
  }

  const respond = async (status: 'accepted' | 'tentative' | 'declined') => {
    if (!selected) return
    setSelected(await source.respond(selected, status))
    toast(status === 'accepted' ? "You're going" : status === 'tentative' ? 'Answered maybe' : 'Declined')
    await refresh()
  }

  return (
    <div className="storage calendar">
      <aside className="s-side" aria-label="Upcoming events">
        <div className="col-head drag s-side-head">
          <span className="title grow">Calendar</span>
          <button className="ghost" title="New event" aria-label="New event" disabled={!defaultCalendar} onClick={() => startNew()}>
            <Icon name="plus" size={16} />
          </button>
        </div>
        <div className="c-upcoming">
          <div className="u-side-label">Upcoming</div>
          {upcoming.isPending ? (
            <div className="loading"><span className="spinner" /></div>
          ) : upcoming.isError ? (
            <p className="c-side-note">Couldn't load events. <button className="c-link" onClick={() => void upcoming.refetch()}>Try again</button></p>
          ) : groups.length === 0 ? (
            <p className="c-side-note">Nothing in the next {UPCOMING_DAYS} days.</p>
          ) : (
            groups.map(([day, list]) => (
              <section key={day} className="c-group">
                <h3 className="c-group-head">{dayHeading(day, today)}</h3>
                {list.map((e) => (
                  <button key={e.id} className="c-item" aria-current={selected && selectionKey(selected) === selectionKey(e) ? 'true' : undefined} onClick={() => open(e, true)}>
                    <span className={`c-mark${e.calendarId === defaultCalendar?.id ? ' is-main' : ''}`} />
                    <span className="c-item-text">
                      <span className="c-item-title ellipsis">{e.title || '(No title)'}</span>
                      <span className="c-item-time">{e.myStatus === 'needs-action' ? `${rangeLabel(e)} · Invited` : rangeLabel(e)}</span>
                    </span>
                  </button>
                ))}
              </section>
            ))
          )}
        </div>
        {calendars.data && calendars.data.length > 0 && (
          <div className="c-calendars">
            <div className="u-side-label">Calendars</div>
            {calendars.data.map((c) => (
              <label key={c.id} className="c-cal-toggle">
                <input type="checkbox" checked={!hidden.includes(c.id)} onChange={() => toggleCalendar(c.id)} />
                <span className={`c-mark${c.isDefault ? ' is-main' : ''}`} />
                <span className="ellipsis">{c.name}</span>
              </label>
            ))}
          </div>
        )}
      </aside>

      <section className="s-main c-main">
        <div className="col-head drag s-head c-head">
          <button className="btn btn-sm" onClick={() => grid()?.today()}>Today</button>
          <span className="row-gap c-nav">
            <button className="ghost" aria-label="Previous" title="Previous" onClick={() => grid()?.prev()}>
              <Icon name="chevron-left" size={16} />
            </button>
            <button className="ghost" aria-label="Next" title="Next" onClick={() => grid()?.next()}>
              <Icon name="chevron-right" size={16} />
            </button>
          </span>
          <span className="c-range-title">{range?.title ?? ''}</span>
          {events.isFetching && <span className="spinner" aria-label="Loading" />}
          <span className="spacer" />
          <div className="seg c-views" role="group" aria-label="View">
            {(['day', 'week', 'month'] as const).map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => changeView(v)}>
                {v[0]!.toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="c-grid">
          {calendars.isError ? (
            <div className="empty">
              <Icon name="circle-alert" size={22} />
              <strong>Couldn't open your calendar</strong>
              <span>{calendars.error.message}</span>
              <button className="btn btn-sm" onClick={() => void calendars.refetch()}>Try again</button>
            </div>
          ) : (
            <CalendarGrid
              gridRef={gridRef}
              view={view}
              events={gridEvents}
              defaultCalendarId={defaultCalendar?.id ?? null}
              selectedKey={selected ? selectionKey(selected) : null}
              onRange={(r) => {
                setRange({ from: r.from, to: r.to, title: r.title })
                if (r.view !== view) setView(r.view)
              }}
              onOpen={(e) => open(e)}
              onPick={(r) => startNew(r)}
            />
          )}
        </div>

        {editing && calendars.data ? (
          <EventEditor
            key={editing.event?.id ?? 'new'}
            event={editing.event}
            initial={editing.draft}
            calendars={calendars.data}
            orgId={orgId}
            onSave={save}
            onCancel={() => {
              grid()?.unselect()
              setEditing(null)
            }}
          />
        ) : (
          selected &&
          calendars.data && (
            <EventPanel
              key={selected.id}
              event={selected}
              calendars={calendars.data}
              onEdit={() => setEditing({ event: selected, draft: draftOf(selected) })}
              onDelete={remove}
              onRespond={respond}
              onClose={() => setSelected(null)}
            />
          )
        )}
      </section>
    </div>
  )
}
