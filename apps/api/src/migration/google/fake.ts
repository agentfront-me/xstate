// A made-up Google Workspace for local development (GOOGLE_MODE=fake): the domain is the admin email's, and the
// admin is its first user. Each active person has a small Gmail (30–59 messages, see fakeMailbox) that covers every
// label case the copy handles; discovery reports that real count, while the sizes stay the made-up big ones. Test hooks: an admin address starting with "nodrive" fails the Gmail and Drive checks,
// and one starting with "nobody" isn't known to "Google".

import { GoogleError } from './auth'
import { FOLDER_MIME, GOOGLE_EXPORTS, exportName } from './workspace'
import { zonedToUtc } from '../../mailserver/calendar-events'
import type { GChangePage, GContact, GDomain, GDrive, GDriveFile, GEvent, GGroup, GHistory, GLabel, GPermission, GRawMessage, GUser, Permission, UserCounts, Usage, Workspace } from './workspace'

const GB = 1024 ** 3

type Seed = { local: string; name: string; mailGb: number; driveGb: number; messages: number; contacts: number; files: number; suspended?: boolean; aliases?: string[] }

const PEOPLE: Seed[] = [
  { local: 'priya', name: 'Priya Raman', mailGb: 6.2, driveGb: 14, messages: 48_210, contacts: 812, files: 3_120, aliases: ['p.raman'] },
  { local: 'marcus', name: 'Marcus Oyelaran', mailGb: 19.4, driveGb: 61, messages: 152_004, contacts: 1_904, files: 9_870 },
  { local: 'sofia', name: 'Sofia Keller', mailGb: 11.8, driveGb: 3.1, messages: 61_337, contacts: 402, files: 611 },
  { local: 'jordan', name: 'Jordan Lee', mailGb: 2.4, driveGb: 0.8, messages: 9_120, contacts: 133, files: 204 },
  { local: 'amara', name: 'Amara Osei', mailGb: 4.0, driveGb: 22, messages: 30_552, contacts: 590, files: 4_411, aliases: ['sales'] },
  { local: 'theo', name: 'Theo Brandt', mailGb: 3.2, driveGb: 1.2, messages: 21_870, contacts: 0, files: 380, suspended: true },
  { local: 'rhea', name: 'Rhea Nair', mailGb: 0.2, driveGb: 0.1, messages: 1_240, contacts: 0, files: 12, suspended: true },
]

const domainOf = (email: string) => email.split('@')[1]!.toLowerCase()
const people = (adminEmail: string): (Seed & { email: string })[] => {
  const domain = domainOf(adminEmail)
  const admin: Seed = { local: adminEmail.split('@')[0]!, name: 'Workspace Admin', mailGb: 3.5, driveGb: 5, messages: 22_400, contacts: 310, files: 980 }
  return [admin, ...PEOPLE].map((p) => ({ ...p, email: `${p.local}@${domain}` }))
}

export const fakeWorkspace: Workspace = {
  async clientId() {
    return '100000000000000000001'
  },

  async checkScopes(adminEmail) {
    const local = adminEmail.split('@')[0]!
    const noUser = local.startsWith('nobody')
    const partial = local.startsWith('nodrive')
    const checks: Record<Permission, boolean> = { directory: !noUser, gmail: !noUser && !partial, contacts: !noUser, drive: !noUser && !partial, calendar: !noUser }
    return { checks, noUser }
  },

  async listUsers(adminEmail) {
    return people(adminEmail).map((p, i): GUser => {
      return {
        id: `g-${p.local}`,
        email: p.email,
        name: p.name,
        suspended: !!p.suspended,
        isAdmin: i === 0,
        aliases: (p.aliases ?? []).map((a) => `${a}@${domainOf(adminEmail)}`),
        // Everyone but Jordan has a personal address on file, so both ways of inviting get exercised.
        recovery: p.local === 'jordan' ? null : `${p.local}.home@example.org`,
      }
    })
  },

  async listDomains(adminEmail): Promise<GDomain[]> {
    const domain = domainOf(adminEmail)
    return [
      { name: domain, kind: 'primary' },
      { name: `${domain.split('.')[0]}-mail.test`, kind: 'alias' },
    ]
  },

  async listGroups(adminEmail): Promise<GGroup[]> {
    const d = domainOf(adminEmail)
    return [
      { id: 'grp-support', email: `support@${d}`, name: 'Support', members: 3, aliases: [`help@${d}`] },
      { id: 'grp-team', email: `team@${d}`, name: 'Everyone', members: 6, aliases: [] },
    ]
  },

  async groupMemberEmails(adminEmail, groupId) {
    const d = domainOf(adminEmail)
    if (groupId === 'grp-support') return [`priya@${d}`, `sofia@${d}`, `jordan@${d}`]
    return people(adminEmail).filter((p) => !p.suspended).map((p) => p.email)
  },

  async listSharedDrives(): Promise<GDrive[]> {
    return [
      { id: 'drv-marketing', name: 'Marketing assets', members: 5 },
      { id: 'drv-finance', name: 'Finance', members: 2 },
    ]
  },

  async usage(adminEmail) {
    return new Map<string, Usage>(people(adminEmail).map((p) => [p.email, { mailBytes: Math.round(p.mailGb * GB), driveBytes: Math.round(p.driveGb * GB) }]))
  },

  async countUser(email): Promise<UserCounts> {
    // Anyone not in the list is the admin (whose local part is whatever they typed).
    const p = PEOPLE.find((x) => x.local === email.split('@')[0]) ?? people(email)[0]!
    // Like Google: suspended users can't be acted as, so only their sizes are known.
    if (p.suspended) return { messages: null, contacts: null, files: null, error: 'Suspended in Google: only sizes are known' }
    await new Promise((r) => setTimeout(r, 300))
    return { messages: fakeMailbox(email).length, contacts: fakeContacts(email, 'connections').length, files: fakeDrive(email).filter((f) => f.mimeType !== FOLDER_MIME).length }
  },

  async gmailProfile(email) {
    refuseSuspended(email)
    return { historyId: '1000', messagesTotal: fakeMailbox(email).length }
  },

  async gmailLabels(): Promise<GLabel[]> {
    return [
      ...['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'CHAT', 'CATEGORY_SOCIAL'].map((id) => ({ id, name: id, type: 'system' as const })),
      { id: 'Label_1', name: 'Clients', type: 'user' },
      { id: 'Label_2', name: 'Clients/Acme', type: 'user' },
    ]
  },

  async gmailList(email, { q, pageToken, pageSize }) {
    refuseSuspended(email)
    const after = q?.match(/after:(\d{4})\/(\d{2})\/(\d{2})/)
    const since = after ? Date.UTC(Number(after[1]), Number(after[2]) - 1, Number(after[3])) : 0
    const all = fakeMailbox(email).filter((m) => m.internalDate >= since)
    const start = Number(pageToken ?? 0)
    const next = start + pageSize
    return { ids: all.slice(start, next).map((m) => m.id), nextPageToken: next < all.length ? String(next) : null, resultSizeEstimate: all.length }
  },

  async contactsPage(email, which, pageToken) {
    refuseSuspended(email)
    const all = fakeContacts(email, which)
    const start = Number(pageToken ?? 0)
    const next = start + CONTACT_PAGE
    return { contacts: all.slice(start, next), nextPageToken: next < all.length ? String(next) : null, total: all.length }
  },

  async contactGroups() {
    return new Map([
      ['contactGroups/clients', 'Clients'],
      ['contactGroups/family', 'Family'],
    ])
  },

  async fetchPhoto(url) {
    if (!url.startsWith('fake://')) return null
    // A 1×1 PNG.
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    return { bytes: png.buffer, type: 'image/png' }
  },

  async driveList(email, { folders, driveId, pageToken, pageSize }) {
    refuseSuspended(email)
    const all = (driveId ? fakeSharedDrive(email, driveId) : fakeDrive(email)).filter((f) => (f.mimeType === FOLDER_MIME) === folders)
    const start = Number(pageToken ?? 0)
    const next = start + pageSize
    const page = all.slice(start, next)
    return { files: await Promise.all(page.map(withMd5)), nextPageToken: next < all.length ? String(next) : null }
  },

  async driveDownload(email, file, driveId) {
    // An edited file has the same id as the original: the size asked for says which version.
    const candidates = driveId ? fakeSharedDrive(email, driveId) : [...driveChangesFor(email), ...fakeDrive(email)]
    const spec = candidates.find((f) => f.id === file.id && (file.size === null || f.bytes === file.size))
    if (!spec) throw new GoogleError('not_found', 'No such fake file', 404)
    const exp = GOOGLE_EXPORTS[spec.mimeType]
    const name = exp ? exportName(spec.name, exp.ext) : spec.name
    return { body: fakeBytes(spec), size: exp ? null : spec.bytes, contentType: exp?.mime ?? spec.mimeType, name, md5: exp ? null : file.md5 }
  },

  async sharedDriveOrganizer(adminEmail, driveId) {
    const d = domainOf(adminEmail)
    return driveId === 'drv-marketing' ? `priya@${d}` : driveId === 'drv-finance' ? `sofia@${d}` : null
  },

  async sharedDrivePermissions(adminEmail, driveId): Promise<GPermission[]> {
    const d = domainOf(adminEmail)
    const user = (local: string, role: string): GPermission => ({ type: 'user', role, email: `${local}@${d}`, domain: null })
    if (driveId === 'drv-marketing') return [user('priya', 'organizer'), user('sofia', 'writer'), user('jordan', 'reader'), user('amara', 'fileOrganizer')]
    if (driveId === 'drv-finance') return [user('sofia', 'organizer'), user('marcus', 'reader')]
    return []
  },

  // The final pass sees, for everyone: one new message, the first message starred, the second deleted; in Drive a
  // new file and an edited notes.txt.
  async gmailHistory(email, startHistoryId): Promise<GHistory> {
    refuseSuspended(email)
    const box = fakeMailbox(email)
    return {
      added: startHistoryId === '1000' ? [newMessage(email).id] : [],
      labelled: startHistoryId === '1000' ? [{ id: box[0]!.id, labelIds: ['INBOX', 'STARRED'] }] : [],
      deleted: startHistoryId === '1000' ? [box[1]!.id] : [],
      nextPageToken: null,
      historyId: '2000',
    }
  },

  async driveStartToken() {
    return 'start-1'
  },

  async driveChanges(email, token, driveId): Promise<GChangePage> {
    refuseSuspended(email)
    if (token !== 'start-1' || driveId) return { changes: [], nextPageToken: null, newStartPageToken: token }
    const [added, edited] = driveChangesFor(email)
    return {
      changes: [
        { fileId: added.id, removed: false, file: await withMd5(added) },
        { fileId: edited.id, removed: false, file: await withMd5(edited) },
      ],
      nextPageToken: null,
      newStartPageToken: 'start-2',
    }
  },

  async gmailSizes(email, ids) {
    const all = new Map([...fakeMailbox(email), newMessage(email)].map((m) => [m.id, m.sizeEstimate]))
    // The thirteenth message claims to be huge, so the copy skips it as too large without downloading it.
    const huge = fakeMailbox(email)[12]?.id
    return new Map(ids.filter((id) => all.has(id)).map((id) => [id, id === huge ? 200_000_000 : all.get(id)!]))
  },

  async gmailRaw(email, id, options = {}) {
    if (id === newMessage(email).id) return newMessage(email)
    const m = fakeMailbox(email).find((x) => x.id === id)
    if (!m) throw new GoogleError('not_found', 'The message is gone from Gmail', 404)
    // The fourteenth is rate limited the first time it's read in an isolate, like Gmail under load.
    if (id === fakeMailbox(email)[13]?.id && !throttled.has(id)) {
      throttled.add(id)
      throw new GoogleError('rate_limited', 'Google is limiting how fast xstate can read. Try again in a minute.', 429)
    }
    if (options.maxBytes !== undefined && m.raw.byteLength > options.maxBytes) throw new GoogleError('too_large', `${m.raw.byteLength} bytes`, 200)
    return m
  },

  async calendarList(email) {
    const local = email.split('@')[0]!
    return [
      { id: email, name: email, primary: true, timeZone: FAKE_TZ },
      { id: `offsite-${local}@group.calendar.google.com`, name: 'Team offsite', primary: false, timeZone: 'Europe/Lisbon' },
    ]
  },

  async eventsPage(email, calendarId, { pageToken, syncToken }) {
    if (syncToken?.startsWith('expired')) throw new GoogleError('gone', 'Google’s change list expired', 410)
    const all = fakeEvents(email, calendarId)
    const token = (n: number) => `sync-${n}:${calendarId}`
    if (syncToken) {
      // The first sync after the copy brings an added, an edited and a deleted event; later ones nothing new.
      const changes = syncToken === token(1) ? fakeChanges(email, calendarId) : []
      return { events: changes, nextPageToken: null, nextSyncToken: token(2) }
    }
    const start = pageToken ? Number(pageToken) : 0
    const page = all.slice(start, start + FAKE_EVENT_PAGE)
    const more = start + FAKE_EVENT_PAGE < all.length
    return { events: page, nextPageToken: more ? String(start + FAKE_EVENT_PAGE) : null, nextSyncToken: more ? null : token(1) }
  },
}

// ---------------------------------------------------------------------------------------------------------------
// Calendar: a week or two around today in New York time, covering every case the copy handles. Small pages, and the
// changed occurrences come before their series, as Google may list them.

const FAKE_TZ = 'America/New_York'
const FAKE_EVENT_PAGE = 4

/** Monday of this week, as YYYY-MM-DD. */
function fakeMonday(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}
const day = (n: number) => {
  const d = new Date(`${fakeMonday()}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** A New York wall time on day n as Google sends it: a UTC instant plus the zone. */
const at = (n: number, time: string, tz = FAKE_TZ) => ({ dateTime: zonedToUtc(`${day(n)}T${time}`, tz), timeZone: tz })
const compact = (n: number, time: string) => `${day(n).replaceAll('-', '')}T${time.replace(':', '')}00`

function fakeEvents(email: string, calendarId: string): GEvent[] {
  const domain = domainOf(email)
  const self = { email, self: true }
  if (calendarId !== email) {
    return [
      { id: 'off1', summary: 'Offsite: travel', start: { date: day(10) }, end: { date: day(12) }, iCalUID: `off1-${calendarId}` },
      { id: 'off2', summary: 'Offsite dinner', location: 'Lisbon', start: at(10, '19:30', 'Europe/Lisbon'), end: at(10, '22:00', 'Europe/Lisbon'), iCalUID: `off2-${calendarId}` },
    ]
  }
  const colleague = (local: string, status: 'accepted' | 'needsAction' | 'declined' | 'tentative' = 'accepted') => ({ email: `${local}@${domain}`, responseStatus: status })
  return [
    // A changed and a cancelled occurrence of the standup, listed before the series itself.
    { id: 'standup_ex1', recurringEventId: 'standup', originalStartTime: at(1, '09:00'), summary: 'Standup (moved)', start: at(1, '10:00'), end: at(1, '10:15'), iCalUID: `standup-${email}` },
    { id: 'standup_ex2', recurringEventId: 'standup', originalStartTime: at(3, '09:00'), status: 'cancelled' },
    {
      id: 'standup',
      summary: 'Standup',
      start: at(0, '09:00'),
      end: at(0, '09:15'),
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=40', `EXDATE;TZID=${FAKE_TZ}:${compact(2, '09:00')}`],
      organizer: self,
      iCalUID: `standup-${email}`,
    },
    {
      id: 'review',
      summary: 'Design review',
      description: 'Walk through the Q1 tiers.',
      location: 'Room 2',
      start: at(1, '14:00'),
      end: at(1, '15:00'),
      organizer: self,
      attendees: [{ ...self, responseStatus: 'accepted', organizer: true }, colleague('priya'), colleague('marcus', 'tentative'), { email: 'ext@example.org', displayName: 'Ext Partner', responseStatus: 'needsAction' }, { email: `room-2@resource.calendar.google.com`, resource: true, responseStatus: 'accepted' }],
      iCalUID: `review-${email}`,
      sequence: 0,
    },
    {
      id: 'client',
      summary: 'Call: Maria Lopez',
      start: at(2, '15:00'),
      end: at(2, '15:30'),
      organizer: { email: 'maria@example.org', displayName: 'Maria Lopez' },
      attendees: [{ email: 'maria@example.org', displayName: 'Maria Lopez', organizer: true, responseStatus: 'accepted' }, { ...self, responseStatus: 'needsAction' }],
      iCalUID: 'client-call@example.org',
    },
    {
      id: 'allhands',
      summary: 'All hands',
      start: at(4, '16:00'),
      end: at(4, '17:00'),
      organizer: { email: `ceo@${domain}`, displayName: 'The CEO' },
      attendees: [
        { email: `ceo@${domain}`, organizer: true, responseStatus: 'accepted' },
        ...Array.from({ length: 23 }, (_, i) => colleague(`person${i + 1}`)),
        { ...self, responseStatus: 'accepted' },
      ],
      iCalUID: `allhands@${domain}`,
    },
    { id: 'dayoff', summary: 'Day off', start: { date: day(11) }, end: { date: day(12) }, transparency: 'transparent', iCalUID: `dayoff-${email}` },
    { id: 'monthly', summary: 'Month-end close', start: at(4, '17:00'), end: at(4, '17:30'), recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;WKST=MO'], iCalUID: `monthly-${email}` },
    { id: 'wl', eventType: 'workingLocation', summary: 'Home', start: { date: day(0) }, end: { date: day(1) } },
    { id: 'old', status: 'cancelled' },
  ]
}

function fakeChanges(email: string, calendarId: string): GEvent[] {
  if (calendarId !== email) return []
  const review = fakeEvents(email, calendarId).find((e) => e.id === 'review')!
  return [
    { id: 'kickoff', summary: 'Kickoff (added after the copy)', start: at(5, '11:00'), end: at(5, '11:30'), iCalUID: `kickoff-${email}` },
    { ...review, summary: 'Design review (v2)', sequence: 1 },
    { id: 'dayoff', status: 'cancelled' },
  ]
}

/** Small pages, so paging gets exercised. */
const CONTACT_PAGE = 15

/**
 * A person's fake contacts (20–39) or "Other contacts" (10). Every fourth contact is in Clients, every sixth in
 * Family, every fifth has a photo. Contacts 3 and 4 share an email (merged into one), and the first Other contact
 * has the same email as a real contact (it stays a real contact).
 */
function fakeContacts(email: string, which: 'connections' | 'other'): GContact[] {
  const local = email.split('@')[0]!
  if (which === 'other') {
    return Array.from({ length: 10 }, (_, i) => ({
      id: `otherContacts/${local}-${i}`,
      name: i % 2 ? null : `Auto Saved ${i}`,
      emails: [i === 0 ? `contact0.${local}@example.com` : `auto${i}.${local}@example.org`],
      phones: [],
      company: null,
      title: null,
      addresses: [],
      birthday: null,
      notes: null,
      photoUrl: null,
      labels: [],
    }))
  }
  const n = 20 + ([...local].reduce((s, c) => s + c.charCodeAt(0), 0) % 20)
  return Array.from({ length: n }, (_, i) => ({
    id: `people/${local}-c${i}`,
    name: `Contact ${i} of ${local}`,
    emails: [i === 4 ? `contact3.${local}@example.com` : `contact${i}.${local}@example.com`, ...(i % 3 === 0 ? [`work${i}@example.net`] : [])],
    phones: i % 2 ? [`+1 555 01${String(i).padStart(2, '0')}`] : [],
    company: i % 4 === 0 ? 'Acme Corp' : null,
    title: i % 4 === 0 ? 'Buyer' : null,
    addresses: i === 1 ? ['1 Main St, Springfield'] : [],
    birthday: i === 2 ? '1990-04-12' : null,
    notes: i === 5 ? 'Met at the trade fair.' : null,
    photoUrl: i % 5 === 0 ? `fake://photo/${local}/${i}` : null,
    labels: [...(i % 4 === 0 ? ['contactGroups/clients'] : []), ...(i % 6 === 0 ? ['contactGroups/family'] : []), 'contactGroups/myContacts'],
  }))
}

type FakeFile = GDriveFile & { bytes: number; seed: string; badMd5?: boolean }

const MB = 1024 * 1024
const GDOC = 'application/vnd.google-apps.document'
const GSHEET = 'application/vnd.google-apps.spreadsheet'

/**
 * A person's fake My Drive. Folders are listed child before parent ("2026" inside "Projects"), so the copy has to
 * order them. Files cover: plain files in nested folders, a Doc and a Sheet (exported), a Form and a shortcut
 * (skipped), sharing with a colleague, a group, the whole domain, anyone with the link and an outsider, and a
 * file whose checksum doesn't match. Sofia also has a 105 MB file (stored with a multipart upload).
 */
function fakeDrive(email: string): FakeFile[] {
  const local = email.split('@')[0]!
  const d = domainOf(email)
  const colleague = local === 'priya' ? 'sofia' : 'priya'
  const f = (id: string, name: string, mimeType: string, parents: string[], bytes: number, permissions: GPermission[] = [], extra: Partial<FakeFile> = {}): FakeFile => ({
    id: `${local}-${id}`,
    name,
    mimeType,
    parents: parents.map((p) => `${local}-${p}`),
    size: mimeType.startsWith('application/vnd.google-apps') ? null : bytes,
    md5: null,
    permissions,
    bytes,
    seed: `${local}-${id}`,
    ...extra,
  })
  const files: FakeFile[] = [
    f('f2026', '2026', FOLDER_MIME, ['fprojects'], 0),
    f('fprojects', 'Projects', FOLDER_MIME, ['root'], 0),
    f('fpersonal', 'Personal', FOLDER_MIME, ['root'], 0),
    f('notes', 'notes.txt', 'text/plain', ['f2026'], 2_000, [{ type: 'user', role: 'writer', email: `${colleague}@${d}`, domain: null }]),
    f('budget', 'Budget', GSHEET, ['fprojects'], 6_000, [{ type: 'domain', role: 'reader', email: null, domain: d }]),
    f('plan', 'Plan', GDOC, ['root'], 4_000, [{ type: 'group', role: 'reader', email: `support@${d}`, domain: null }]),
    f('survey', 'Survey', 'application/vnd.google-apps.form', ['root'], 0),
    f('shortcut', 'Shortcut to notes', 'application/vnd.google-apps.shortcut', ['root'], 0),
    f('photo', 'photo.png', 'image/png', ['fpersonal'], 30_000),
    f('public', 'public.pdf', 'application/pdf', ['root'], 9_000, [
      { type: 'anyone', role: 'reader', email: null, domain: null },
      { type: 'user', role: 'writer', email: 'someone@outside.example', domain: null },
    ]),
    f('broken', 'broken.bin', 'application/octet-stream', ['root'], 1_000, [], { badMd5: true }),
  ]
  if (local === 'sofia') files.push(f('big', 'big-video.mp4', 'video/mp4', ['fpersonal'], 105 * MB))
  return files
}

function fakeSharedDrive(_email: string, driveId: string): FakeFile[] {
  const f = (id: string, name: string, mimeType: string, parents: string[], bytes: number): FakeFile => ({
    id: `${driveId}-${id}`,
    name,
    mimeType,
    parents: parents.map((p) => (p === 'root' ? driveId : `${driveId}-${p}`)),
    size: mimeType.startsWith('application/vnd.google-apps') ? null : bytes,
    md5: null,
    permissions: [],
    bytes,
    seed: `${driveId}-${id}`,
  })
  if (driveId === 'drv-marketing') {
    return [f('fcamp', 'Campaigns', FOLDER_MIME, ['root'], 0), f('brief', 'brief.txt', 'text/plain', ['fcamp'], 3_000), f('logo', 'logo.png', 'image/png', ['root'], 12_000)]
  }
  if (driveId === 'drv-finance') return [f('q3', 'Q3 forecast', GSHEET, ['root'], 5_000)]
  return []
}

/** Deterministic bytes for a fake file: a repeated line, so big files are cheap to make. */
function fakeBytes(spec: FakeFile): ReadableStream<Uint8Array> {
  const line = new TextEncoder().encode(`${spec.seed} fake content line\n`)
  const chunk = new Uint8Array(Math.min(spec.bytes || line.length, 256 * 1024))
  for (let i = 0; i < chunk.length; i++) chunk[i] = line[i % line.length]!
  let sent = 0
  const total = spec.bytes || line.length
  return new ReadableStream({
    pull(c) {
      if (sent >= total) return c.close()
      const n = Math.min(chunk.length, total - sent)
      c.enqueue(chunk.slice(0, n))
      sent += n
    },
  })
}

/** Google's checksum for stored files: the real MD5 of the fake bytes (or a wrong one, for badMd5). Skipped above 10 MB. */
async function withMd5(spec: FakeFile): Promise<GDriveFile> {
  const { bytes: _b, seed: _s, badMd5, ...file } = spec
  if (file.size === null || spec.bytes > 10 * MB) return file
  if (badMd5) return { ...file, md5: '00000000000000000000000000000000' }
  const digest = new crypto.DigestStream('MD5')
  await fakeBytes(spec).pipeTo(digest)
  return { ...file, md5: [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, '0')).join('') }
}

/** A message that arrived in Gmail after the copy, for the final pass. */
function newMessage(email: string): GRawMessage {
  const local = email.split('@')[0]!
  const raw = new TextEncoder().encode(
    [`From: late@example.com`, `To: ${email}`, `Subject: Arrived during the switch`, `Date: Sun, 8 Nov 2026 10:00:00 +0000`, `Message-ID: <late-${local}@gmail.test>`, 'MIME-Version: 1.0', 'Content-Type: text/plain', '', 'This came in after the copy.', ''].join('\r\n'),
  )
  return { id: `mnew-${local}`, labelIds: ['INBOX', 'UNREAD'], internalDate: Date.UTC(2026, 10, 8, 10), sizeEstimate: raw.byteLength, raw }
}

/** Drive's changes after the copy: a new file at the top, and notes.txt edited (new content, same id). */
function driveChangesFor(email: string): [FakeFile, FakeFile] {
  const notes = fakeDrive(email).find((f) => f.name === 'notes.txt')!
  const local = email.split('@')[0]!
  const added: FakeFile = { ...notes, id: `${local}-newreport`, name: 'new-report.txt', parents: [`${local}-root`], permissions: [], bytes: 1_500, size: 1_500, seed: `${local}-newreport` }
  const edited: FakeFile = { ...notes, bytes: 2_500, size: 2_500, seed: `${notes.seed}-v2` }
  return [added, edited]
}

/** Like Google: a suspended account can't be acted as. */
function refuseSuspended(email: string) {
  if (PEOPLE.find((x) => x.local === email.split('@')[0])?.suspended) {
    throw new GoogleError('no_such_user', `Google won't let xstate act as ${email}: account is suspended`, 400)
  }
}

/**
 * A small, fixed Gmail for one person, newest first. Message i gets labels by i % 10:
 *   0–2 Inbox (every third unread)   3 Sent   4 Inbox + starred + "Clients"   5 "Clients/Acme" only
 *   6 no labels (archived)   7 Spam   8 Trash   9 a draft, or a chat message from i = 20 (chats are skipped)
 * Every seventh has a small attachment. One message a week, the oldest 59 weeks before 2026-11-01.
 */
/** Fake messages already rate limited once in this isolate. */
const throttled = new Set<string>()

function fakeMailbox(email: string): GRawMessage[] {
  const local = email.split('@')[0]!
  const n = 30 + ([...local].reduce((s, c) => s + c.charCodeAt(0), 0) % 30)
  const out: GRawMessage[] = []
  for (let i = 0; i < n; i++) {
    const kind = i % 10
    const labels =
      kind <= 2 ? ['INBOX', ...(i % 3 === 0 ? ['UNREAD'] : []), 'CATEGORY_SOCIAL']
      : kind === 3 ? ['SENT']
      : kind === 4 ? ['INBOX', 'STARRED', 'IMPORTANT', 'Label_1']
      : kind === 5 ? ['Label_2']
      : kind === 6 ? []
      : kind === 7 ? ['SPAM', 'UNREAD']
      : kind === 8 ? ['TRASH', 'INBOX']
      : i < 20 ? ['DRAFT']
      : ['CHAT']
    const date = Date.UTC(2026, 10, 1) - i * 7 * 86_400_000
    const sent = kind === 3 || kind === 9
    const from = sent ? email : `dana${i}@example.com`
    const to = sent ? `dana${i}@example.com` : email
    const subject = `Fake message ${i + 1} (${labels.join(', ') || 'archived'})`
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date(date).toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <fake-${i}-${local}@gmail.test>`,
      'MIME-Version: 1.0',
    ]
    const body = `Hello ${local},\r\n\r\nThis is fake message ${i + 1} from the local Google Workspace.\r\n`
    const raw =
      i % 7 === 0
        ? [
            ...headers,
            'Content-Type: multipart/mixed; boundary="b1"',
            '',
            '--b1',
            'Content-Type: text/plain; charset=utf-8',
            '',
            body,
            '--b1',
            `Content-Type: text/plain; name="notes-${i + 1}.txt"`,
            `Content-Disposition: attachment; filename="notes-${i + 1}.txt"`,
            '',
            `Attachment for message ${i + 1}.`,
            '--b1--',
            '',
          ].join('\r\n')
        : [...headers, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n')
    const bytes = new TextEncoder().encode(raw)
    out.push({ id: `m${String(i).padStart(4, '0')}-${local}`, labelIds: labels, internalDate: date, sizeEstimate: bytes.byteLength, raw: bytes })
  }
  return out
}
