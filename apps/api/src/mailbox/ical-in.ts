// Reading invitation files (iCalendar with an iTIP method) that reach a store-held mailbox (docs/mailbox-store-plan.md,
// phase 3c): the reverse of ./ical-out.ts. ical.js parses; the result is the JSCalendar event the store keeps (the
// shape ../mailserver/calendar-events.ts reads), so the same code shows, stores and answers it. Time zones: an IANA
// TZID is kept, a Windows one (Outlook) is mapped, anything else is matched by its offsets. Pure: no runtime imports.

import ICAL from 'ical.js'
import { mailto, toDuration, withSeconds, zoneOffsetMinutes } from '../mailserver/calendar-events.ts'
import type { JmapEvent, JmapParticipant } from '../mailserver/stalwart/calendar'
import { exdateKeys, parseRrule } from '../migration/calendar-rules.ts'

export type ItipIn = 'request' | 'reply' | 'cancel' | 'other'

export type ParsedCalendar = {
  method: ItipIn
  uid: string
  /** The event as the file describes it (id and calendar empty), or null when the file only has single occurrences. */
  event: JmapEvent | null
  /** Occurrences the file speaks about on their own (RECURRENCE-ID), by original local start in the event's zone. */
  occurrences: Record<string, JmapEvent>
}

/** The first event in an iCalendar text, or null when there is none. Throws nothing: a broken file reads as null. */
export function parseIcs(text: string): ParsedCalendar | null {
  let root: ICAL.Component
  try {
    root = new ICAL.Component(ICAL.parse(text))
  } catch {
    return null
  }
  const method = (String(root.getFirstPropertyValue('method') ?? '').toLowerCase() || 'other') as string
  const zones = new Map<string, ICAL.Timezone>()
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    const id = String(tz.getFirstPropertyValue('tzid') ?? '')
    if (id) zones.set(id, new ICAL.Timezone(tz))
  }
  const vevents = root.getAllSubcomponents('vevent')
  const uid = String(vevents[0]?.getFirstPropertyValue('uid') ?? '')
  if (!uid) return null
  const mine = vevents.filter((v) => String(v.getFirstPropertyValue('uid') ?? '') === uid)
  const master = mine.find((v) => !v.hasProperty('recurrence-id')) ?? null

  // The zone everything is keyed in: the master's, else the first occurrence's.
  const zone = zoneOf((master ?? mine[0]!).getFirstProperty('dtstart'), zones)
  const event = master ? toEvent(master, zones, zone) : null
  const occurrences: Record<string, JmapEvent> = {}
  for (const v of mine) {
    if (v === master) continue
    const key = localIn(v.getFirstProperty('recurrence-id'), zones, zone)
    if (key) occurrences[key] = toEvent(v, zones, zone)
  }
  if (event && master) {
    // Changed occurrences become the series' overrides, as the store keeps them.
    const overrides: Record<string, Record<string, unknown>> = { ...(event.recurrenceOverrides ?? {}) }
    for (const [key, o] of Object.entries(occurrences)) overrides[key] = overrideOf(event, o)
    if (Object.keys(overrides).length) event.recurrenceOverrides = overrides
  }
  return { method: (['request', 'reply', 'cancel'].includes(method) ? method : 'other') as ItipIn, uid, event, occurrences }
}

function toEvent(v: ICAL.Component, zones: Map<string, ICAL.Timezone>, seriesZone: string | null): JmapEvent {
  const start = v.getFirstProperty('dtstart')
  const allDay = start?.getFirstValue() instanceof ICAL.Time && (start.getFirstValue() as ICAL.Time).isDate
  const zone = allDay ? null : (zoneOf(start, zones) ?? seriesZone)
  const local = allDay ? `${String(start!.getFirstValue()).slice(0, 10)}T00:00:00` : (localIn(start, zones, zone) ?? '1970-01-01T00:00:00')

  let minutes = 0
  const end = v.getFirstProperty('dtend')
  const duration = v.getFirstPropertyValue('duration') as ICAL.Duration | null
  if (end && start) minutes = Math.round((absolute(end, zones) - absolute(start, zones)) / 60_000)
  else if (duration) minutes = Math.round(duration.toSeconds() / 60)
  else if (allDay) minutes = 1440

  const e: JmapEvent = {
    id: '',
    calendarIds: {},
    '@type': 'Event',
    uid: String(v.getFirstPropertyValue('uid') ?? ''),
    sequence: Number(v.getFirstPropertyValue('sequence') ?? 0) || 0,
    title: String(v.getFirstPropertyValue('summary') ?? ''),
    description: String(v.getFirstPropertyValue('description') ?? ''),
    start: local,
    duration: allDay ? `P${Math.max(1, Math.round(minutes / 1440))}D` : toDuration(Math.max(0, minutes)),
    timeZone: zone,
    showWithoutTime: allDay,
  } as JmapEvent
  const location = String(v.getFirstPropertyValue('location') ?? '').trim()
  e.locations = location ? { l: { '@type': 'Location', name: location } } : null
  const status = String(v.getFirstPropertyValue('status') ?? '').toLowerCase()
  if (status === 'cancelled' || status === 'tentative' || status === 'confirmed') e.status = status

  const rrule = v.getFirstProperty('rrule')
  if (rrule) {
    const text = rrule.getFirstValue()!.toString()
    const rule = parseRrule(`RRULE:${text}`)
    // UNTIL in UTC (required with a TZID) is read in the event's own zone, as JSCalendar keeps it.
    const utcUntil = /UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(text)
    if (rule && utcUntil && zone) {
      const ms = Date.UTC(+utcUntil[1]!, +utcUntil[2]! - 1, +utcUntil[3]!, +utcUntil[4]!, +utcUntil[5]!, +utcUntil[6]!)
      rule.until = new Date(ms + zoneOffsetMinutes(zone, ms) * 60_000).toISOString().slice(0, 19)
    }
    if (rule) e.recurrenceRule = rule as JmapEvent['recurrenceRule']
    const excluded = v
      .getAllProperties('exdate')
      .flatMap((p) => exdateLine(p, zones, zone ?? 'UTC', allDay))
    if (excluded.length) e.recurrenceOverrides = Object.fromEntries(excluded.map((k) => [k, { excluded: true }]))
  }

  const organizer = mailto(String(v.getFirstPropertyValue('organizer') ?? ''))
  if (organizer) e.organizerCalendarAddress = `mailto:${organizer}`
  e.participants = participantsOf(v, organizer)
  return e
}

/** ORGANIZER and ATTENDEE lines as JSCalendar participants; the organizer is the owner (and an attendee if listed). */
function participantsOf(v: ICAL.Component, organizer: string | null): Record<string, JmapParticipant> | null {
  const out: Record<string, JmapParticipant> = {}
  const orgProp = v.getFirstProperty('organizer')
  if (organizer) {
    out.o = { '@type': 'Participant', name: (orgProp?.getParameter('cn') as string | undefined) ?? null, calendarAddress: `mailto:${organizer}`, roles: { owner: true } }
  }
  let n = 0
  for (const a of v.getAllProperties('attendee')) {
    const email = mailto(String(a.getFirstValue() ?? ''))
    if (!email) continue
    const status = PARTSTAT[String(a.getParameter('partstat') ?? 'NEEDS-ACTION').toUpperCase()] ?? 'needs-action'
    const name = (a.getParameter('cn') as string | undefined) ?? null
    if (email === organizer) {
      out.o = { ...out.o!, roles: { owner: true, attendee: true }, participationStatus: status, name: out.o!.name ?? name }
      continue
    }
    const roles: Record<string, true> = { attendee: true }
    if (String(a.getParameter('role') ?? '').toUpperCase() === 'OPT-PARTICIPANT') roles.optional = true
    out[`a${++n}`] = {
      '@type': 'Participant',
      name,
      calendarAddress: `mailto:${email}`,
      roles,
      participationStatus: status,
      ...(String(a.getParameter('rsvp') ?? '').toUpperCase() === 'TRUE' && { expectReply: true }),
    }
  }
  return Object.keys(out).length ? out : null
}

const PARTSTAT: Record<string, string> = { ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative', 'NEEDS-ACTION': 'needs-action', DELEGATED: 'declined' }

/** What an occurrence changes compared with its series, as a JSCalendar override. */
export function overrideOf(series: JmapEvent, o: JmapEvent): Record<string, unknown> {
  const change: Record<string, unknown> = {}
  for (const field of ['start', 'duration', 'title', 'description', 'locations', 'status', 'participants'] as const) {
    // An exception that leaves a field out (Outlook often drops the location, status and guests) keeps the series'.
    const value = o[field]
    if (field !== 'start' && field !== 'duration' && (value === undefined || value === null || value === '')) continue
    if (field === 'participants' && !Object.values(value as NonNullable<JmapEvent['participants']>).some((p) => !p.roles?.owner)) continue
    if (JSON.stringify(value ?? null) !== JSON.stringify(series[field] ?? null)) change[field] = value ?? null
  }
  if (o.status === 'cancelled') change.excluded = true
  return change
}

// ---------------------------------------------------------------------------------------------------------------
// Times and zones

/** The IANA zone for a time property, or null for all-day, UTC or floating times. */
function zoneOf(prop: ICAL.Property | null, zones: Map<string, ICAL.Timezone>): string | null {
  if (!prop) return null
  const value = prop.getFirstValue()
  if (!(value instanceof ICAL.Time) || value.isDate) return null
  const tzid = prop.getParameter('tzid') as string | undefined
  if (!tzid) return null
  return ianaZone(tzid, zones.get(tzid) ?? null, value.year)
}

/** A time property as local time in `zone` (converted when the property is in another zone or UTC). */
function localIn(prop: ICAL.Property | null, zones: Map<string, ICAL.Timezone>, zone: string | null): string | null {
  if (!prop) return null
  const value = prop.getFirstValue()
  if (!(value instanceof ICAL.Time)) return null
  if (value.isDate) return `${value.toString().slice(0, 10)}T00:00:00`
  const own = zoneOf(prop, zones)
  const floating = !prop.getParameter('tzid') && !value.toString().endsWith('Z')
  if (floating || (own && own === zone)) return value.toString().slice(0, 19)
  const ms = absolute(prop, zones)
  const target = zone ?? 'UTC'
  return new Date(ms + zoneOffsetMinutes(target, ms) * 60_000).toISOString().slice(0, 19)
}

/** A time property as a UTC instant in ms, using the file's own VTIMEZONE when the zone isn't one the runtime knows. */
function absolute(prop: ICAL.Property, zones: Map<string, ICAL.Timezone>): number {
  const value = (prop.getFirstValue() as ICAL.Time).clone()
  if (value.isDate) return Date.parse(`${value.toString().slice(0, 10)}T00:00:00Z`)
  const tzid = prop.getParameter('tzid') as string | undefined
  if (!tzid && value.toString().endsWith('Z')) return Date.parse(value.toString())
  const local = value.toString().slice(0, 19)
  const iana = tzid ? ianaZone(tzid, zones.get(tzid) ?? null, value.year) : null
  if (iana) return wallToUtc(local, iana)
  const file = tzid ? zones.get(tzid) : null
  if (file) return Date.parse(`${local}Z`) - file.utcOffset(value) * 1000
  return Date.parse(`${local}Z`)
}

function wallToUtc(local: string, zone: string): number {
  const wall = Date.parse(`${withSeconds(local)}Z`)
  let t = wall - zoneOffsetMinutes(zone, wall) * 60_000
  t = wall - zoneOffsetMinutes(zone, t) * 60_000
  return t
}

function exdateLine(p: ICAL.Property, zones: Map<string, ICAL.Timezone>, zone: string, allDay: boolean): string[] {
  const tzid = p.getParameter('tzid') as string | undefined
  return p.getValues().flatMap((value) => {
    const t = value as ICAL.Time
    if (allDay || t.isDate) return exdateKeys(`EXDATE;VALUE=DATE:${t.toString().slice(0, 10).replace(/-/g, '')}`, zone, true)
    const asProp = new ICAL.Property('exdate')
    if (tzid) asProp.setParameter('tzid', tzid)
    asProp.setValue(t)
    const local = localIn(asProp, zones, zone)
    return local ? [local] : []
  })
}

const knownZones = new Map<string, boolean>()
function isIana(zone: string): boolean {
  if (!knownZones.has(zone)) {
    let ok = false
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone })
      ok = /\//.test(zone) || zone === 'UTC'
    } catch {
      ok = false
    }
    knownZones.set(zone, ok)
  }
  return knownZones.get(zone)!
}

/**
 * The IANA zone for a TZID: itself when the runtime knows it, a Windows name through CLDR's table, otherwise the first
 * well-known zone whose offsets in January and July of `year` match the file's VTIMEZONE. Null when nothing fits.
 */
export function ianaZone(tzid: string, file: ICAL.Timezone | null, year: number): string | null {
  const id = tzid.replace(/^\/.*?\//, '').trim()
  if (isIana(id)) return id
  const windows = WINDOWS_ZONES[id]
  if (windows) return windows
  if (!file) return null
  const jan = ICAL.Time.fromData({ year, month: 1, day: 15, hour: 12 })
  const jul = ICAL.Time.fromData({ year, month: 7, day: 15, hour: 12 })
  const want = [file.utcOffset(jan) / 60, file.utcOffset(jul) / 60]
  const janMs = Date.UTC(year, 0, 15, 12)
  const julMs = Date.UTC(year, 6, 15, 12)
  return MATCH_ORDER.find((z) => zoneOffsetMinutes(z, janMs) === want[0] && zoneOffsetMinutes(z, julMs) === want[1]) ?? null
}

/** Windows time zone names (Outlook, Exchange) → IANA, from CLDR's windowsZones (territory 001). */
export const WINDOWS_ZONES: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time (Mexico)': 'America/Mazatlan',
  'Mountain Standard Time': 'America/Denver',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indianapolis',
  'Venezuela Standard Time': 'America/Caracas',
  'Paraguay Standard Time': 'America/Asuncion',
  'Atlantic Standard Time': 'America/Halifax',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'Greenland Standard Time': 'America/Godthab',
  'Montevideo Standard Time': 'America/Montevideo',
  'UTC-02': 'Etc/GMT+2',
  'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Morocco Standard Time': 'Africa/Casablanca',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Jordan Standard Time': 'Asia/Amman',
  'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut',
  'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Syria Standard Time': 'Asia/Damascus',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Arab Standard Time': 'Asia/Riyadh',
  'Belarus Standard Time': 'Europe/Minsk',
  'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Mauritius Standard Time': 'Indian/Mauritius',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Calcutta',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Katmandu',
  'Central Asia Standard Time': 'Asia/Almaty',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Myanmar Standard Time': 'Asia/Rangoon',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'China Standard Time': 'Asia/Shanghai',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'Magadan Standard Time': 'Asia/Magadan',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC+12': 'Etc/GMT-12',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Tonga Standard Time': 'Pacific/Tongatapu',
  'Samoa Standard Time': 'Pacific/Apia',
}

/** Zones tried, in order, when a file's own zone has to be matched by offsets: the commonest first. */
const MATCH_ORDER = [...new Set(['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Karachi', 'Asia/Calcutta', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', ...Object.values(WINDOWS_ZONES)])].filter(isIana)
