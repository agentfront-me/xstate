// Labels for times and days, in the design's style: "11 AM", "2:30 PM", "11 AM – 12 PM", "Wed, Nov 11".

import { addDays, type CalendarEvent, instant, localDate } from './api'

/** "11 AM", "2:30 PM" */
export function timeLabel(d: Date): string {
  const h = d.getHours()
  const m = d.getMinutes()
  const hour = h % 12 || 12
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`
}

/** "11 AM – 12 PM", or "All day". Multi-day ranges add the end date. */
export function rangeLabel(e: Pick<CalendarEvent, 'allDay' | 'start' | 'end'>): string {
  if (e.allDay) {
    const days = Math.round((instant(e.end) - instant(e.start)) / 86400000)
    return days > 1 ? `All day · ${days} days` : 'All day'
  }
  const start = new Date(e.start)
  const end = new Date(e.end)
  const sameDay = localDate(start) === localDate(end)
  return `${timeLabel(start)} – ${sameDay ? '' : `${shortDay(end)}, `}${timeLabel(end)}`
}

/** "Wed, Nov 11" */
export function shortDay(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/** "Tuesday, November 10" */
export function longDay(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

/** The Upcoming list's group heading for a local date: Today, Tomorrow, or "Wed, Nov 11". */
export function dayHeading(date: string, today: string): string {
  if (date === today) return 'Today'
  if (date === addDays(today, 1)) return 'Tomorrow'
  const [y, m, d] = date.split('-').map(Number)
  return shortDay(new Date(y!, m! - 1, d!))
}

/** The panel's date line: "Tue, November 10 · 10 AM – 11 AM". */
export function whenLabel(e: CalendarEvent): string {
  const day = longDay(new Date(instant(e.start)))
  if (e.allDay) {
    const days = Math.round((instant(e.end) - instant(e.start)) / 86400000)
    return days > 1 ? `${day} – ${longDay(new Date(instant(e.end) - 86400000))}` : day
  }
  return `${day} · ${rangeLabel(e)}`
}

/** Whether a timed event is short enough to show on one line (the design's ~50 minutes). */
export const isShort = (e: Pick<CalendarEvent, 'allDay' | 'start' | 'end'>) =>
  !e.allDay && instant(e.end) - instant(e.start) <= 50 * 60000

export const statusLabel: Record<string, string> = {
  'needs-action': 'Pending',
  accepted: 'Accepted',
  declined: 'Declined',
  tentative: 'Maybe',
}
