// The Day / Week / Month grid: FullCalendar 7 with no theme of its own, styled through its …Class options and
// calendar.css to match the design (black and white, current-time line, all-day row, sticky day headers).

import 'temporal-polyfill/global'
import '@fullcalendar/react/skeleton.css'
import FullCalendar, { type CalendarRef } from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/react/daygrid'
import interactionPlugin from '@fullcalendar/react/interaction'
import timeGridPlugin from '@fullcalendar/react/timegrid'
import { type Ref, useMemo } from 'react'
import type { CalendarEvent } from './api'
import { isShort, rangeLabel, timeLabel } from './format'

export type View = 'day' | 'week' | 'month'
export const FC_VIEW: Record<View, string> = { day: 'timeGridDay', week: 'timeGridWeek', month: 'dayGridMonth' }

type Props = {
  gridRef: Ref<CalendarRef>
  view: View
  events: CalendarEvent[]
  /** Calendars drawn as the default (solid) calendar; the rest are drawn muted. */
  defaultCalendarId: string | null
  /** selectionKey() of the open event: the same occurrence stays selected whichever id it was opened by. */
  selectedKey: string | null
  onRange: (range: { from: Date; to: Date; title: string; view: View }) => void
  onOpen: (event: CalendarEvent) => void
  /** A dragged time range, or a clicked day in Month view. */
  onPick: (range: { start: Date; end: Date; allDay: boolean }) => void
}

/** An occurrence's identity across ids: its series (or itself) plus its start. */
export const selectionKey = (e: CalendarEvent) => `${e.seriesId ?? e.id}@${e.start}`

export function CalendarGrid({ gridRef, view, events, defaultCalendarId, selectedKey, onRange, onOpen, onPick }: Props) {
  const input = useMemo(
    () =>
      events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        extendedProps: { event: e },
      })),
    [events],
  )

  return (
    <FullCalendar
      ref={gridRef}
      plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
      initialView={FC_VIEW[view]}
      headerToolbar={false}
      height="100%"
      timeZone="local"
      nowIndicator
      scrollTime="08:00:00"
      allDaySlot
      tableHeaderSticky
      dayMaxEvents
      fixedWeekCount={false}
      slotMinHeight={22}
      eventMinHeight={18}
      selectable
      selectMirror
      unselectAuto
      events={input}
      datesSet={(info) => {
        const type = info.view.type
        onRange({
          from: info.start,
          to: info.end,
          title: info.view.title,
          view: type === FC_VIEW.day ? 'day' : type === FC_VIEW.month ? 'month' : 'week',
        })
      }}
      eventClick={(info) => {
        info.jsEvent.preventDefault()
        const e = info.event.extendedProps.event as CalendarEvent | undefined
        if (e) onOpen(e)
      }}
      select={(info) => onPick({ start: info.start, end: info.end, allDay: info.allDay })}
      dateClick={(info) => {
        if (info.view.type === FC_VIEW.month) onPick({ start: info.date, end: info.date, allDay: true })
      }}
      slotHeaderFormat={{ hour: 'numeric', meridiem: 'short' }}
      eventTimeFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'short' }}
      slotHeaderContent={(arg) => (arg.isMinor ? '' : timeLabel(arg.date))}
      dayHeaderContent={(arg) =>
        arg.view.type === FC_VIEW.month ? (
          <span className="c-dow">{arg.weekdayText}</span>
        ) : (
          <span className="c-dayhead">
            <span className="c-dow">{arg.weekdayText}</span>
            <span className={`c-daynum${arg.isToday ? ' is-today' : ''}`}>{arg.dayNumberText}</span>
          </span>
        )
      }
      dayHeaderFormat={{ weekday: 'short', day: 'numeric' }}
      dayCellTopContent={(arg) => <span className={`c-daynum${arg.isToday ? ' is-today' : ''}`}>{arg.date.getDate()}</span>}
      allDayHeaderContent={() => ''}
      moreLinkContent={(arg) => `${arg.num} more`}
      eventContent={(arg) => {
        const e = arg.event.extendedProps.event as CalendarEvent | undefined
        // The preview drawn while dragging out a new event carries none of our data.
        if (!e) return <span className="c-ev-one">{arg.timeText}</span>
        const tip = `${e.title} · ${rangeLabel(e)}`
        if (arg.view.type === FC_VIEW.month || e.allDay) {
          return (
            <span className="c-chip-text" title={tip}>
              {!e.allDay && <span className="c-chip-time">{timeLabel(new Date(e.start)).replace(':00', '')} </span>}
              {e.title}
            </span>
          )
        }
        if (isShort(e)) return <span className="c-ev-one" title={tip}>{e.title}</span>
        return (
          <span className="c-ev-body" title={tip}>
            <span className="c-ev-title">{e.title}</span>
            <span className="c-ev-time">{rangeLabel(e)}</span>
          </span>
        )
      }}
      eventClass={(arg) => {
        const e = arg.event.extendedProps.event as CalendarEvent | undefined
        if (!e) return 'c-ev is-mirror'
        return [
          'c-ev',
          e.calendarId === defaultCalendarId ? 'is-main' : 'is-other',
          e.status === 'cancelled' && 'is-cancelled',
          e.myStatus === 'needs-action' && 'is-pending',
          selectionKey(e) === selectedKey && 'is-selected',
        ]
          .filter(Boolean)
          .join(' ')
      }}
      viewClass="c-view"
      tableHeaderClass="c-thead"
      dayHeaderClass={(arg) => `c-dayhd${arg.isToday ? ' is-today' : ''}`}
      dayLaneClass={(arg) => `c-lane${arg.isToday ? ' is-today' : ''}`}
      dayCellClass={(arg) => `c-cell${arg.isToday ? ' is-today' : ''}${arg.isOther ? ' is-other' : ''}`}
      slotLaneClass={(arg) => (arg.isMinor ? 'c-slot is-minor' : 'c-slot')}
      slotHeaderClass="c-slothead"
      allDayHeaderClass="c-slothead"
      nowIndicatorLineClass="c-now"
      nowIndicatorDotClass="c-now-dot"
      nowIndicatorHeaderClass="c-now-head"
      moreLinkClass="c-more"
    />
  )
}
