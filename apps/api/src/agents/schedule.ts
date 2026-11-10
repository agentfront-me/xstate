// When a schedule trigger fires next. Pure (no Workers APIs), so it runs under node:test.
//
// Times are wall-clock times in the trigger's time zone: "every Monday 09:00 Europe/London" stays 09:00 London time
// across daylight saving. The SDK's own cron runs in UTC, so we work out each next time here and schedule that one
// instant; after it fires, the next one is worked out again.

export type Frequency = 'once' | 'interval' | 'daily' | 'weekly' | 'cron'

export type ScheduleSpec = {
  frequency: Frequency
  timezone: string
  /** once: local date-time "YYYY-MM-DDTHH:MM". */
  at?: string
  /** interval: minutes between runs (5 to 10,080). */
  everyMinutes?: number
  /** daily and weekly: local "HH:MM". */
  time?: string
  /** weekly: 0 = Sunday … 6 = Saturday. */
  weekdays?: number[]
  /** cron: five fields (minute hour day-of-month month day-of-week), in the trigger's time zone. */
  cron?: string
}

const MINUTE = 60_000

type Wall = { y: number; m: number; d: number; h: number; mi: number; wd: number }

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(timezone: string) {
  let f = formatters.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    })
    formatters.set(timezone, f)
  }
  return f
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function isTimeZone(timezone: string): boolean {
  try {
    formatter(timezone)
    return true
  } catch {
    return false
  }
}

/** The wall-clock time of an instant in a zone. */
export function wallClock(instant: number, timezone: string): Wall & { s: number } {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(new Date(instant)).map((p) => [p.type, p.value]))
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    mi: Number(parts.minute),
    s: Number(parts.second),
    wd: WEEKDAY[parts.weekday!] ?? 0,
  }
}

function offset(instant: number, timezone: string): number {
  const w = wallClock(instant, timezone)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(instant / 1000) * 1000
}

/**
 * The instant a wall-clock time happens in a zone. A time skipped by a DST jump forward moves to after the jump;
 * a time that happens twice (DST back) takes the first.
 */
export function instantOf(y: number, m: number, d: number, h: number, mi: number, timezone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi)
  // The zone's offset half a day before and after: around a DST change they differ, and each gives one candidate.
  const before = offset(guess - 12 * 3_600_000, timezone)
  const after = offset(guess + 12 * 3_600_000, timezone)
  const candidates = [...new Set([guess - before, guess - after])].sort((a, b) => a - b)
  for (const c of candidates) {
    const w = wallClock(c, timezone)
    if (w.y === y && w.m === m && w.d === d && w.h === h && w.mi === mi) return c
  }
  // Skipped by a jump forward: the old offset puts it just after the jump (01:30 → 02:30).
  return guess - before
}

const parseTime = (time: string | undefined): [number, number] | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time ?? '')
  return m ? [Number(m[1]), Number(m[2])] : null
}

/** Adds days to a calendar date (no time zone involved). */
function addDays(y: number, m: number, d: number, days: number) {
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() }
}

/** Why a schedule is invalid, or null. */
export function validate(spec: ScheduleSpec): string | null {
  if (!isTimeZone(spec.timezone)) return `Unknown time zone ${spec.timezone}`
  switch (spec.frequency) {
    case 'once':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(spec.at ?? '') ? null : 'Pick a date and time'
    case 'interval':
      return Number.isInteger(spec.everyMinutes) && spec.everyMinutes! >= 5 && spec.everyMinutes! <= 10_080
        ? null
        : 'Run every 5 minutes to 7 days'
    case 'daily':
      return parseTime(spec.time) ? null : 'Pick a time'
    case 'weekly':
      if (!parseTime(spec.time)) return 'Pick a time'
      return spec.weekdays?.length && spec.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ? null : 'Pick at least one day'
    case 'cron':
      try {
        parseCron(spec.cron ?? '')
        return null
      } catch (err) {
        return err instanceof Error ? err.message : 'Invalid cron expression'
      }
    default:
      return 'Unknown frequency'
  }
}

/**
 * The next time the schedule fires strictly after `after` (ms), or null when it never will again (a "once" in the
 * past). `last` is when it last fired, for intervals.
 */
export function nextRun(spec: ScheduleSpec, after: number, last?: number | null): number | null {
  const tz = spec.timezone
  switch (spec.frequency) {
    case 'once': {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(spec.at ?? '')
      if (!m) return null
      const t = instantOf(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, tz)
      return t > after ? t : null
    }
    case 'interval': {
      const step = (spec.everyMinutes ?? 60) * MINUTE
      const from = last ?? after
      let t = from + step
      if (t <= after) t = after + step - ((after - from) % step)
      return t
    }
    case 'daily':
    case 'weekly': {
      const [h, mi] = parseTime(spec.time) ?? [9, 0]
      const now = wallClock(after, tz)
      for (let i = 0; i <= 8; i++) {
        const day = addDays(now.y, now.m, now.d, i)
        if (spec.frequency === 'weekly' && !spec.weekdays?.includes(day.wd)) continue
        const t = instantOf(day.y, day.m, day.d, h, mi, tz)
        if (t > after) return t
      }
      return null
    }
    case 'cron':
      return nextCron(parseCron(spec.cron ?? ''), after, tz)
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Five-field cron: minute hour day-of-month month day-of-week. *, lists, ranges, steps; day names and month names
// aren't supported. Like Vixie cron, when both day fields are restricted a day matches if either does.

type Cron = { minutes: number[]; hours: number[]; doms: Set<number>; months: Set<number>; dows: Set<number>; domStar: boolean; dowStar: boolean }

function field(text: string, min: number, max: number, name: string): number[] {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new Error(`Cron ${name}: can't read "${part}"`)
    const step = m[4] ? Number(m[4]) : 1
    let lo = min
    let hi = max
    if (m[1] !== '*') {
      lo = Number(m[2])
      hi = m[3] ? Number(m[3]) : m[4] ? max : lo
    }
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`Cron ${name}: ${part} is out of range ${min}-${max}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('Cron needs five fields: minute hour day month weekday')
  const dows = field(parts[4]!, 0, 7, 'weekday').map((d) => (d === 7 ? 0 : d))
  return {
    minutes: field(parts[0]!, 0, 59, 'minute'),
    hours: field(parts[1]!, 0, 23, 'hour'),
    doms: new Set(field(parts[2]!, 1, 31, 'day')),
    months: new Set(field(parts[3]!, 1, 12, 'month')),
    dows: new Set(dows),
    domStar: parts[2] === '*',
    dowStar: parts[4] === '*',
  }
}

function nextCron(cron: Cron, after: number, tz: string): number | null {
  const now = wallClock(after, tz)
  // Up to ~4 years ahead covers "29 Feb" style expressions.
  for (let i = 0; i < 1500; i++) {
    const day = addDays(now.y, now.m, now.d, i)
    if (!cron.months.has(day.m)) continue
    const domOk = cron.doms.has(day.d)
    const dowOk = cron.dows.has(day.wd)
    const dayOk = cron.domStar && cron.dowStar ? true : cron.domStar ? dowOk : cron.dowStar ? domOk : domOk || dowOk
    if (!dayOk) continue
    for (const h of cron.hours) {
      for (const mi of cron.minutes) {
        const t = instantOf(day.y, day.m, day.d, h, mi, tz)
        if (t > after) return t
      }
    }
  }
  return null
}

/** "Every Monday at 09:00", for lists and logs. */
export function describe(spec: ScheduleSpec): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  switch (spec.frequency) {
    case 'once':
      return `Once on ${(spec.at ?? '').replace('T', ' at ')}`
    case 'interval': {
      const n = spec.everyMinutes ?? 0
      return n % 1440 === 0 ? `Every ${n / 1440} day${n === 1440 ? '' : 's'}` : n % 60 === 0 ? `Every ${n / 60} hour${n === 60 ? '' : 's'}` : `Every ${n} minutes`
    }
    case 'daily':
      return `Every day at ${spec.time}`
    case 'weekly': {
      const set = [...(spec.weekdays ?? [])].sort()
      const label = set.join() === '1,2,3,4,5' ? 'Weekdays' : set.map((d) => days[d]).join(', ')
      return `${label} at ${spec.time}`
    }
    case 'cron':
      return `Cron ${spec.cron}`
  }
}
