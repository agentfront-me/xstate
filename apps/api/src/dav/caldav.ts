// Calendar apps over CalDAV (RFC 4791, with WebDAV RFC 4918, sync-collection RFC 6578 and discovery RFC 6764;
// docs/imap-smtp-relay-plan.md §7). Apple Calendar, Thunderbird and DAVx⁵ read and change a mailbox's calendars here.
// The calendars stay in the mailbox's store as JSCalendar; iCalendar goes in through mailbox/ical-in.ts and out
// through mailbox/ical-out.ts. Changes go through the same calendar code as the web app (mailbox/calendar-store.ts),
// so guests get invitations, updates and cancellations from the server, by email.
//
// Sign-in is HTTP Basic: a mailbox's address and an app password (auth/app-passwords.ts). Addresses:
//   /.well-known/caldav, /dav/                       where an app starts looking
//   /dav/principals/<mailboxId>/                     the signed-in mailbox
//   /dav/calendars/<mailboxId>/                      its calendars
//   /dav/calendars/<mailboxId>/<calendarId>/         one calendar
//   /dav/calendars/<mailboxId>/<calendarId>/<name>   one event, by the file name the app gave it (or its uid + .ics)

import type { Context } from 'hono'
import { authenticateApp, type AppSignIn } from '../auth/app-passwords'
import * as mailboxesDb from '../db/mailboxes'
import type { MailboxRow } from '../db/mailboxes'
import type { AppEnv } from '../http/types'
import { applyPatch, timeColumns } from '../mailbox/calendar-expand'
import { storeCalendars } from '../mailbox/calendar-store'
import { buildIcs } from '../mailbox/ical-out'
import { parseIcs } from '../mailbox/ical-in'
import type { DavEntry, StoreCalendar } from '../mailbox/store'
import { store } from '../mailbox/stub'
import type { StoredEvent } from '../mailserver/calendar-types'
import { EmailError } from '../mailserver/errors'
import { child, children, escapeXml, parseXml, type XmlNode } from './xml'

const D = 'DAV:'
const C = 'urn:ietf:params:xml:ns:caldav'
const CS = 'http://calendarserver.org/ns/'
const A = 'http://apple.com/ns/ical/'
const PREFIX: Record<string, string> = { [D]: 'd', [C]: 'c', [CS]: 'cs', [A]: 'a' }
/** An iCalendar file larger than this isn't taken. */
const MAX_BODY = 2 * 1024 * 1024
/** How long a checked sign-in is trusted without asking again: calendar apps sign every request, dozens a sync. */
const SIGN_IN_TTL_MS = 5 * 60 * 1000
const DEFAULT_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899']

type Ctx = Context<AppEnv>
type Signed = Extract<AppSignIn, { ok: true }> & { mailbox: MailboxRow }

/** Sign-ins checked lately in this isolate, by a hash of address and password. A revoked app password ends within 5 minutes. */
const recent = new Map<string, { at: number; result: Extract<AppSignIn, { ok: true }> }>()

const xml = (body: string, status = 207) =>
  new Response(`<?xml version="1.0" encoding="utf-8"?>\n${body}`, { status, headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers })
const DAV_HEADERS = { DAV: '1, 3, calendar-access, calendar-auto-schedule, extended-mkcol', Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT, MKCALENDAR, MOVE' }

/** Every /dav/* request, and the well-known address that leads to it. */
export async function handleDav(c: Ctx): Promise<Response> {
  const method = c.req.method.toUpperCase()
  const path = new URL(c.req.url).pathname
  if (path.startsWith('/.well-known/caldav')) return empty(301, { Location: '/dav/' })
  if (method === 'OPTIONS') return empty(200, DAV_HEADERS)

  const signed = await signIn(c)
  if (signed instanceof Response) return signed
  const parts = path.replace(/^\/dav\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  // Every address is under the signed-in mailbox; anything else answers as if it didn't exist.
  if (parts.length >= 2 && parts[1] !== signed.mailboxId) return empty(404)
  try {
    if (parts[0] === 'principals' || parts.length === 0) return await principal(c, method, signed, parts.length === 0)
    if (parts[0] !== 'calendars') return empty(404)
    if (parts.length === 2) return await home(c, method, signed)
    if (parts.length === 3) return await calendar(c, method, signed, parts[2]!)
    if (parts.length === 4) return await resource(c, method, signed, parts[2]!, parts[3]!)
    return empty(404)
  } catch (err) {
    if (err instanceof EmailError) return new Response(err.message, { status: err.status >= 500 ? 502 : err.status })
    console.error('caldav: request failed', method, path, err)
    return empty(500)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Signing in

async function signIn(c: Ctx): Promise<Signed | Response> {
  const challenge = () => empty(401, { 'WWW-Authenticate': 'Basic realm="xstate", charset="UTF-8"' })
  const header = c.req.header('Authorization') ?? ''
  const m = /^Basic\s+(\S+)$/i.exec(header)
  if (!m) return challenge()
  let decoded: string
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(m[1]!), (ch) => ch.charCodeAt(0)))
  } catch {
    return challenge()
  }
  const colon = decoded.indexOf(':')
  if (colon < 0) return challenge()
  const address = decoded.slice(0, colon)
  const password = decoded.slice(colon + 1)
  const key = await sha256(`${address.toLowerCase()}\n${password}`)
  let result = recent.get(key)?.result
  if (!result || Date.now() - recent.get(key)!.at > SIGN_IN_TTL_MS) {
    const checked = await authenticateApp(c.env, address, password, c.req.header('CF-Connecting-IP'))
    if (!checked.ok) {
      recent.delete(key)
      if (checked.reason === 'throttled') return new Response('Too many sign-in attempts. Wait a minute and try again.', { status: 429, headers: { 'Retry-After': '60' } })
      if (checked.reason === 'disabled') return new Response('Mail and calendar apps are turned off for this organization', { status: 403 })
      return challenge()
    }
    result = checked
    if (recent.size > 5000) recent.clear()
    recent.set(key, { at: Date.now(), result })
  }
  const mailbox = await mailboxesDb.find(c.env.DB, result.mailboxId)
  if (!mailbox) return challenge()
  return { ...result, mailbox }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------------------------------------------
// Properties

const href = {
  principal: (s: Signed) => `/dav/principals/${s.mailboxId}/`,
  home: (s: Signed) => `/dav/calendars/${s.mailboxId}/`,
  calendar: (s: Signed, id: string) => `/dav/calendars/${s.mailboxId}/${id}/`,
  event: (s: Signed, id: string, name: string) => `/dav/calendars/${s.mailboxId}/${id}/${encodeURIComponent(name)}`,
}

/** The properties asked for (`prop`), or every one we have (`allprop` and an empty body). */
async function wanted(c: Ctx): Promise<{ root: XmlNode | null; names: [string, string][] | 'all' }> {
  const text = await c.req.text()
  if (!text.trim()) return { root: null, names: 'all' }
  const root = parseXml(text)
  const prop = child(root, D, 'prop')
  if (!prop) return { root, names: 'all' }
  return { root, names: prop.children.map((p) => [p.ns, p.name]) }
}

const tag = (ns: string, name: string) => `${PREFIX[ns] ?? 'x'}:${name}`
const NS = `xmlns:d="${D}" xmlns:c="${C}" xmlns:cs="${CS}" xmlns:a="${A}"`

/** One response element: the properties found with 200, the ones we don't have with 404. */
function response(url: string, values: Record<string, string>, names: [string, string][] | 'all'): string {
  const asked = names === 'all' ? Object.keys(values).map((k) => k.split('|') as [string, string]) : names
  const found: string[] = []
  const missing: string[] = []
  for (const [ns, name] of asked) {
    const value = values[`${ns}|${name}`]
    if (value === undefined) missing.push(`<${PREFIX[ns] ? tag(ns, name) : `x:${name} xmlns:x="${escapeXml(ns)}"`}/>`)
    else found.push(value === '' ? `<${tag(ns, name)}/>` : `<${tag(ns, name)}>${value}</${tag(ns, name)}>`)
  }
  return (
    `<d:response><d:href>${escapeXml(url)}</d:href>` +
    (found.length ? `<d:propstat><d:prop>${found.join('')}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>` : '') +
    (missing.length ? `<d:propstat><d:prop>${missing.join('')}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>` : '') +
    `</d:response>`
  )
}

const multistatus = (responses: string[], extra = '') => xml(`<d:multistatus ${NS}>${responses.join('')}${extra}</d:multistatus>`)
const hrefValue = (url: string) => `<d:href>${escapeXml(url)}</d:href>`
const privileges = (s: Signed) =>
  `<d:privilege><d:read/></d:privilege><d:privilege><d:read-current-user-privilege-set/></d:privilege>` +
  (s.canWrite ? `<d:privilege><d:write/></d:privilege><d:privilege><d:write-content/></d:privilege><d:privilege><d:write-properties/></d:privilege><d:privilege><d:bind/></d:privilege><d:privilege><d:unbind/></d:privilege>` : '')

function principalValues(s: Signed): Record<string, string> {
  return {
    [`${D}|current-user-principal`]: hrefValue(href.principal(s)),
    [`${D}|principal-URL`]: hrefValue(href.principal(s)),
    [`${D}|principal-collection-set`]: hrefValue('/dav/principals/'),
    [`${D}|displayname`]: escapeXml(s.mailbox.display_name || s.address),
    [`${D}|resourcetype`]: '<d:principal/><d:collection/>',
    [`${C}|calendar-home-set`]: hrefValue(href.home(s)),
    [`${C}|calendar-user-address-set`]: hrefValue(`mailto:${s.address}`),
    [`${C}|calendar-user-type`]: 'INDIVIDUAL',
    [`${D}|current-user-privilege-set`]: privileges(s),
  }
}

async function calendarValues(s: Signed, cal: StoreCalendar, state: number, index: number): Promise<Record<string, string>> {
  return {
    [`${D}|displayname`]: escapeXml(cal.name),
    [`${D}|resourcetype`]: '<d:collection/><c:calendar/>',
    [`${D}|owner`]: hrefValue(href.principal(s)),
    [`${D}|current-user-principal`]: hrefValue(href.principal(s)),
    [`${D}|current-user-privilege-set`]: privileges(s),
    [`${D}|supported-report-set`]:
      '<d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report>',
    [`${D}|sync-token`]: escapeXml(syncToken(state)),
    [`${CS}|getctag`]: String(state),
    [`${C}|supported-calendar-component-set`]: '<c:comp name="VEVENT"/>',
    [`${C}|calendar-description`]: '',
    [`${C}|schedule-calendar-transp`]: '<c:opaque/>',
    [`${A}|calendar-color`]: escapeXml(cal.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]!),
    [`${A}|calendar-order`]: String(cal.sortOrder + 1),
  }
}

const syncToken = (n: number) => `https://dav.xstate.com/sync/${n}`
const tokenNumber = (token: string | undefined) => {
  const m = /\/sync\/(\d+)$/.exec(token?.trim() ?? '')
  return m ? Number(m[1]) : null
}
const etag = (e: Pick<DavEntry, 'modseq'>) => `"${e.modseq}"`

// ---------------------------------------------------------------------------------------------------------------
// Principal and calendar home

async function principal(c: Ctx, method: string, s: Signed, root: boolean): Promise<Response> {
  if (method !== 'PROPFIND') return empty(method === 'GET' ? 200 : 405)
  const { names } = await wanted(c)
  const values = principalValues(s)
  const url = root ? '/dav/' : href.principal(s)
  if (root) values[`${D}|resourcetype`] = '<d:collection/>'
  return multistatus([response(url, values, names)])
}

async function calendarsFor(c: Ctx, s: Signed) {
  const backend = await storeCalendars(c.env, s.mailbox)
  const stub = await store(c.env, s.mailboxId)
  // A mailbox whose calendars were never opened gets its two first calendars now, as the web app does.
  if (!(await stub.calendarRows()).length) await backend.setUp()
  const calendars = (await stub.calendarRows()).sort((a, b) => a.sortOrder - b.sortOrder)
  return { backend, stub, calendars }
}

async function home(c: Ctx, method: string, s: Signed): Promise<Response> {
  if (method !== 'PROPFIND') return empty(405)
  const { names } = await wanted(c)
  const depth = c.req.header('Depth') ?? '1'
  const { stub, calendars } = await calendarsFor(c, s)
  const state = await stub.davState()
  const own = {
    [`${D}|displayname`]: 'Calendars',
    [`${D}|resourcetype`]: '<d:collection/>',
    [`${D}|owner`]: hrefValue(href.principal(s)),
    [`${D}|current-user-principal`]: hrefValue(href.principal(s)),
    [`${D}|current-user-privilege-set`]: privileges(s),
    [`${CS}|getctag`]: String(state),
  }
  const responses = [response(href.home(s), own, names)]
  if (depth !== '0') for (const [i, cal] of calendars.entries()) responses.push(response(href.calendar(s, cal.id), await calendarValues(s, cal, state, i), names))
  return multistatus(responses)
}

// ---------------------------------------------------------------------------------------------------------------
// A calendar

async function calendar(c: Ctx, method: string, s: Signed, calendarId: string): Promise<Response> {
  const { stub, calendars } = await calendarsFor(c, s)
  const index = calendars.findIndex((cal) => cal.id === calendarId)
  const cal = calendars[index]

  if (method === 'MKCALENDAR' || (method === 'MKCOL' && !cal)) {
    if (!s.canWrite) return empty(403)
    if (cal) return empty(405)
    const body = parseXml(await c.req.text())
    const name = child(body, D, 'displayname', true)?.text.trim() || 'Calendar'
    const color = child(body, A, 'calendar-color', true)?.text.trim() || null
    // Calendar apps choose the address of a new calendar, and keep using it: it becomes the calendar's id.
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(calendarId)) return empty(403)
    await stub.setCalendarRows([{ id: calendarId, name: name.slice(0, 100), color: color ? color.slice(0, 9) : null, isDefault: false, sortOrder: calendars.length }])
    return empty(201)
  }
  if (!cal) return empty(404)

  if (method === 'DELETE') {
    if (!s.canWrite) return empty(403)
    return empty((await stub.davDeleteCalendar(cal.id)) ? 204 : 403)
  }
  if (method === 'PROPPATCH') {
    if (!s.canWrite) return empty(403)
    const body = parseXml(await c.req.text())
    const set = child(body, D, 'set')
    const name = child(set, D, 'displayname', true)?.text.trim()
    const color = child(set, A, 'calendar-color', true)?.text.trim()
    const order = child(set, A, 'calendar-order', true)?.text.trim()
    await stub.setCalendarRows([{
      ...cal,
      name: name ? name.slice(0, 100) : cal.name,
      color: color ? color.slice(0, 9) : cal.color,
      sortOrder: order && /^\d+$/.test(order) ? Math.max(Number(order) - 1, 0) : cal.sortOrder,
    }])
    const changed = (set?.children.flatMap((p) => p.children) ?? []).map((p) => `<${PREFIX[p.ns] ? tag(p.ns, p.name) : p.name}/>`)
    return multistatus([`<d:response><d:href>${escapeXml(href.calendar(s, cal.id))}</d:href><d:propstat><d:prop>${changed.join('')}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`])
  }
  if (method === 'PROPFIND') {
    const { names } = await wanted(c)
    const state = await stub.davState()
    const responses = [response(href.calendar(s, cal.id), await calendarValues(s, cal, state, index), names)]
    if ((c.req.header('Depth') ?? '0') !== '0') {
      for (const e of await stub.davList(cal.id)) responses.push(response(href.event(s, cal.id, e.name), eventValues(e), names === 'all' ? [[D, 'getetag'], [D, 'getcontenttype']] : names))
    }
    return multistatus(responses)
  }
  if (method === 'REPORT') return report(c, s, cal)
  return empty(405, DAV_HEADERS)
}

const eventValues = (e: DavEntry): Record<string, string> => ({
  [`${D}|getetag`]: escapeXml(etag(e)),
  [`${D}|getcontenttype`]: 'text/calendar; charset=utf-8; component=vevent',
  [`${D}|resourcetype`]: '',
})

// ---------------------------------------------------------------------------------------------------------------
// REPORT: calendar-multiget, calendar-query, sync-collection

async function report(c: Ctx, s: Signed, cal: StoreCalendar): Promise<Response> {
  const body = await c.req.text()
  const root = parseXml(body)
  if (!root) return empty(400)
  const prop = child(root, D, 'prop')
  const names: [string, string][] = prop ? prop.children.map((p) => [p.ns, p.name]) : [[D, 'getetag']]
  const withData = names.some(([ns, name]) => ns === C && name === 'calendar-data')
  const stub = await store(c.env, s.mailboxId)
  const all = await stub.davList(cal.id)
  const byName = new Map(all.map((e) => [e.name, e]))

  const answer = async (entries: DavEntry[]) => {
    const json = withData ? new Map((await stub.eventRows(entries.map((e) => e.id))).map((r) => [r.id, r.json])) : null
    return entries.map((e) => {
      const values = eventValues(e)
      const text = json?.get(e.id)
      if (text) values[`${C}|calendar-data`] = escapeXml(icsOf(JSON.parse(text) as StoredEvent))
      return response(href.event(s, cal.id, e.name), values, names)
    })
  }

  if (root.ns === C && root.name === 'calendar-multiget') {
    const out: string[] = []
    const found: DavEntry[] = []
    for (const h of children(root, D, 'href')) {
      const name = decodeURIComponent(h.text.trim().split('/').filter(Boolean).pop() ?? '')
      const e = byName.get(name)
      if (e) found.push(e)
      else out.push(`<d:response><d:href>${escapeXml(h.text.trim())}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`)
    }
    return multistatus([...(await answer(found)), ...out])
  }
  if (root.ns === C && root.name === 'calendar-query') {
    const range = child(root, C, 'time-range', true)
    let entries = all
    if (range && (range.attrs.start || range.attrs.end)) {
      const iso = (v: string | undefined, fallback: string) => (v ? v.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z') : fallback)
      const inRange = new Set((await stub.eventsInRange(iso(range.attrs.start, '1900-01-01T00:00:00Z'), iso(range.attrs.end, '2200-01-01T00:00:00Z'), cal.id)).map((r) => r.id))
      entries = all.filter((e) => inRange.has(e.id))
    }
    return multistatus(await answer(entries))
  }
  if (root.ns === D && root.name === 'sync-collection') {
    const state = await stub.davState()
    const since = tokenNumber(child(root, D, 'sync-token')?.text)
    if (since === null) return multistatus(await answer(all), `<d:sync-token>${escapeXml(syncToken(state))}</d:sync-token>`)
    const changes = await stub.davChanges(cal.id, since)
    if (!changes.complete) {
      return xml(`<d:error ${NS}><d:valid-sync-token/></d:error>`, 403)
    }
    const gone = changes.deleted
      .filter((name) => !byName.has(name))
      .map((name) => `<d:response><d:href>${escapeXml(href.event(s, cal.id, name))}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`)
    return multistatus([...(await answer(changes.changed)), ...gone], `<d:sync-token>${escapeXml(syncToken(state))}</d:sync-token>`)
  }
  return empty(403)
}

/** An event as a calendar app reads it: iCalendar without a METHOD, since it isn't an invitation. */
function icsOf(e: StoredEvent): string {
  return buildIcs({ method: 'REQUEST', event: e }).replace(/^METHOD:REQUEST\r\n/m, '')
}

// ---------------------------------------------------------------------------------------------------------------
// One event

async function resource(c: Ctx, method: string, s: Signed, calendarId: string, name: string): Promise<Response> {
  const { backend, stub, calendars } = await calendarsFor(c, s)
  const cal = calendars.find((x) => x.id === calendarId)
  if (!cal) return empty(404)
  const current = await stub.davGet(cal.id, name)

  if (method === 'GET' || method === 'HEAD') {
    if (!current) return empty(404)
    return new Response(method === 'HEAD' ? null : icsOf(JSON.parse(current.json) as StoredEvent), {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', ETag: etag(current) },
    })
  }
  if (method === 'PROPFIND') {
    if (!current) return empty(404)
    const { names } = await wanted(c)
    return multistatus([response(href.event(s, cal.id, name), eventValues(current), names)])
  }
  if (!s.canWrite) return empty(403)

  if (method === 'DELETE') {
    if (!current) return empty(404)
    if (!matches(c, current)) return empty(412)
    await backend.destroyEvent(current.id, true).catch(sentAnyway)
    return empty(204)
  }
  if (method === 'MOVE') {
    if (!current) return empty(404)
    const destination = new URL(c.req.header('Destination') ?? '', c.req.url).pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const target = calendars.find((x) => x.id === destination[3])
    if (destination[0] !== 'dav' || destination[2] !== s.mailboxId || !target || !destination[4]) return empty(502)
    await stub.davPlace(current.id, target.id, destination[4])
    return empty(201)
  }
  if (method !== 'PUT') return empty(405, DAV_HEADERS)

  if (Number(c.req.header('Content-Length') ?? 0) > MAX_BODY) return empty(413)
  const text = await c.req.text()
  if (text.length > MAX_BODY) return empty(413)
  if (c.req.header('If-None-Match') === '*' && current) return empty(412)
  if (current && !matches(c, current)) return empty(412)
  const parsed = parseIcs(text)
  if (!parsed?.event) return new Response('The file has no event this calendar can keep', { status: 415 })
  const incoming = parsed.event
  const { id: _id, calendarIds: _c, ...fields } = incoming

  if (current) {
    // Every field the file describes replaces ours; one it no longer has is cleared.
    const patch: Record<string, unknown> = { ...fields }
    for (const field of ['description', 'locations', 'participants', 'recurrenceRule', 'recurrenceOverrides', 'status', 'organizerCalendarAddress'] as const) {
      if (!(field in fields) || fields[field] === undefined) patch[field] = null
    }
    // The app keeps the sequence it was given; our own change rules (calendar-store.ts) raise it when guests must hear.
    delete patch.sequence
    validate(applyPatch(JSON.parse(current.json) as Record<string, unknown>, patch) as unknown as StoredEvent)
    await backend.updateEvent(current.id, patch, true).catch(sentAnyway)
    await stub.davPlace(current.id, cal.id, name)
    const after = await stub.davGet(cal.id, name)
    return empty(204, after ? { ETag: etag(after) } : {})
  }
  // A new event. One already here with the same uid (in another calendar) is moved, not doubled.
  const existing = parsed.uid ? await stub.eventByUid(parsed.uid) : null
  if (existing) {
    await backend.updateEvent(existing, { ...fields, calendarIds: { [cal.id]: true } }, true).catch(sentAnyway)
    await stub.davPlace(existing, cal.id, name)
  } else {
    const event = { ...fields, calendarIds: { [cal.id]: true } } as Record<string, unknown>
    validate({ ...event, id: 'new' } as unknown as StoredEvent)
    const id = await backend.createEvent(event, true).catch(async (err) => {
      // Saved, but emailing the guests failed: it still exists, so the app is told it worked.
      if (err instanceof EmailError && err.code === 'invite_send_failed') return (await stub.eventByUid(parsed.uid))!
      throw err
    })
    await stub.davPlace(id, cal.id, name)
  }
  const after = await stub.davGet(cal.id, name)
  return empty(201, after ? { ETag: etag(after) } : {})
}

/** If-Match: the change applies only to the version the app last saw. */
function matches(c: Ctx, current: DavEntry): boolean {
  const ifMatch = c.req.header('If-Match')
  return !ifMatch || ifMatch === '*' || ifMatch.split(',').map((t) => t.trim().replace(/^W\//, '')).includes(etag(current))
}

/** A start or repeat rule we can't place in time is refused before anything is saved. */
function validate(e: StoredEvent) {
  try {
    timeColumns(e)
  } catch (err) {
    throw new EmailError('invalid_event', `This event can't be saved: ${err instanceof Error ? err.message : String(err)}`, 400)
  }
}

/** A change was saved but emailing the guests failed: the calendar app still hears it worked. Logged. */
function sentAnyway(err: unknown) {
  if (err instanceof EmailError && err.code === 'invite_send_failed') {
    console.error('caldav: saved, but emailing guests failed', err.message)
    return undefined as never
  }
  throw err
}
