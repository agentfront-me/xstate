// What discovery reads from a Google Workspace, behind one interface with two implementations:
//   live: Google's Admin SDK, Reports, Gmail, People and Drive APIs through domain-wide delegation (./auth.ts)
//   fake: a made-up Workspace for local development (./fake.ts), picked with GOOGLE_MODE=fake
// Every call is read-only.

import { accessToken, GoogleError, googleGet, serviceAccount, type GoogleKeyEnv } from './auth'
import { fakeWorkspace } from './fake'

export type Permission = 'directory' | 'gmail' | 'contacts' | 'drive' | 'calendar'

/**
 * The scopes the admin grants, by permission. The wizard shows these (one comma-separated line per permission) and
 * Verify asks for a token with each set. Reports is under Directory: it's the only per-user size Google gives.
 */
export const SCOPES: Record<Permission, readonly string[]> = {
  directory: [
    'https://www.googleapis.com/auth/admin.directory.user.readonly',
    'https://www.googleapis.com/auth/admin.directory.group.readonly',
    'https://www.googleapis.com/auth/admin.directory.domain.readonly',
    'https://www.googleapis.com/auth/admin.reports.usage.readonly',
  ],
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
  contacts: ['https://www.googleapis.com/auth/contacts.readonly', 'https://www.googleapis.com/auth/contacts.other.readonly'],
  drive: ['https://www.googleapis.com/auth/drive.readonly'],
  calendar: ['https://www.googleapis.com/auth/calendar.readonly'],
}

export const PERMISSIONS = Object.keys(SCOPES) as Permission[]

/** `recovery`: the personal address Google has for them, where their invite can go. */
export type GUser = { id: string; email: string; name: string; suspended: boolean; isAdmin: boolean; aliases: string[]; recovery: string | null }
export type GGroup = { id: string; email: string; name: string; members: number; aliases: string[] }
export type GDomain = { name: string; kind: 'primary' | 'secondary' | 'alias' }
export type GDrive = { id: string; name: string; members: number | null }
export type Usage = { mailBytes: number; driveBytes: number }
export type UserCounts = { messages: number | null; contacts: number | null; files: number | null; error?: string }

export type GLabel = { id: string; name: string; type: 'system' | 'user' }
export type GPage = { ids: string[]; nextPageToken: string | null; resultSizeEstimate: number }
/** A message as Gmail stores it: the raw RFC 5322 bytes plus its labels and received time. */
export type GRawMessage = { id: string; labelIds: string[]; internalDate: number; sizeEstimate: number; raw: Uint8Array }

/** A Google contact, flattened. `labels` are contact group resource names; `photoUrl` only for a real photo. */
export type GContact = {
  id: string
  name: string | null
  emails: string[]
  phones: string[]
  company: string | null
  title: string | null
  addresses: string[]
  birthday: string | null
  notes: string | null
  photoUrl: string | null
  labels: string[]
}
export type GContactPage = { contacts: GContact[]; nextPageToken: string | null; total: number }

/** A calendar the person owns. Others' calendars they subscribe to, holidays and birthdays are left out. */
export type GCalendar = { id: string; name: string; primary: boolean; timeZone: string | null }
export type GEventTime = { date?: string; dateTime?: string; timeZone?: string }
export type GAttendee = {
  email?: string
  displayName?: string
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted'
  organizer?: boolean
  self?: boolean
  optional?: boolean
  resource?: boolean
}
/**
 * A Google Calendar event as the API returns it (singleEvents=false): a single event, a repeating series (with
 * RRULE/EXDATE lines in `recurrence`), or a changed or cancelled occurrence of one (`recurringEventId`).
 */
export type GEvent = {
  id: string
  status?: 'confirmed' | 'tentative' | 'cancelled'
  summary?: string
  description?: string
  location?: string
  start?: GEventTime
  end?: GEventTime
  recurrence?: string[]
  recurringEventId?: string
  originalStartTime?: GEventTime
  attendees?: GAttendee[]
  organizer?: { email?: string; displayName?: string; self?: boolean }
  iCalUID?: string
  sequence?: number
  eventType?: string
  transparency?: 'opaque' | 'transparent'
}
/** One page of events. `nextSyncToken` comes with the last page: pass it later to get only what changed. */
export type GEventPage = { events: GEvent[]; nextPageToken: string | null; nextSyncToken: string | null }

/** Who a Drive item is shared with. */
export type GPermission = { type: 'user' | 'group' | 'domain' | 'anyone'; role: string; email: string | null; domain: string | null }
export type GDriveFile = {
  id: string
  name: string
  mimeType: string
  parents: string[]
  /** Bytes for stored files; null for Google Docs, Sheets and the like (exported on download). */
  size: number | null
  md5: string | null
  permissions: GPermission[]
}
export type GDrivePage = { files: GDriveFile[]; nextPageToken: string | null }
/** A file's bytes as xstate stores it: Google files exported to Office formats, with the name to use. */
export type GDownload = { body: ReadableStream<Uint8Array>; size: number | null; contentType: string; name: string; md5: string | null }

/** What changed in Gmail since a history id: messages added, labels changed (with the labels now), deleted. */
export type GHistory = {
  added: string[]
  labelled: { id: string; labelIds: string[] }[]
  deleted: string[]
  nextPageToken: string | null
  historyId: string
}
/** A Drive change: a file added or edited (with its metadata now), or removed. */
export type GChange = { fileId: string; removed: boolean; file: GDriveFile | null }
export type GChangePage = { changes: GChange[]; nextPageToken: string | null; newStartPageToken: string | null }

/** Pass/fail per permission. `noUser`: Google doesn't know the admin email, or won't act as it. */
export type ScopeCheck = { checks: Record<Permission, boolean>; noUser: boolean }

export interface Workspace {
  /** The client ID admins paste into Domain-wide delegation. */
  clientId(): Promise<string>
  checkScopes(adminEmail: string): Promise<ScopeCheck>
  /** Throws GoogleError('forbidden') when the admin isn't a Workspace admin. */
  listUsers(adminEmail: string): Promise<GUser[]>
  listDomains(adminEmail: string): Promise<GDomain[]>
  listGroups(adminEmail: string): Promise<GGroup[]>
  groupMemberEmails(adminEmail: string, groupId: string): Promise<string[]>
  listSharedDrives(adminEmail: string): Promise<GDrive[]>
  /** Mail and Drive bytes per user email, from the newest usage report Google has (usually 2–4 days old). */
  usage(adminEmail: string): Promise<Map<string, Usage>>
  /** Messages, contacts and files of one user, acting as that user. */
  countUser(email: string): Promise<UserCounts>

  // Gmail, acting as the user. Spam and trash are included: they're copied too.
  gmailProfile(email: string): Promise<{ historyId: string; messagesTotal: number }>
  gmailLabels(email: string): Promise<GLabel[]>
  /** One page of message ids, newest first. `q` is a Gmail search (the date range: "after:2021/11/08"). */
  gmailList(email: string, options: { q?: string; pageToken?: string | null; pageSize: number }): Promise<GPage>
  /** Throws GoogleError('too_large') without reading the body when the message is over `maxBytes`. */
  gmailRaw(email: string, id: string, maxBytes?: number): Promise<GRawMessage>

  // Contacts, acting as the user. 'connections' are their contacts; 'other' are Google's auto-saved "Other contacts".
  contactsPage(email: string, which: 'connections' | 'other', pageToken: string | null): Promise<GContactPage>
  /** Contact group (label) resource name → name, user-made groups only. */
  contactGroups(email: string): Promise<Map<string, string>>
  /** A contact photo's bytes (photo URLs need no token), or null if it can't be fetched. */
  fetchPhoto(url: string): Promise<{ bytes: ArrayBuffer; type: string } | null>

  // Drive, acting as `email`: the files they own in My Drive, or (with driveId) a shared drive they organize.
  driveList(email: string, options: { folders: boolean; driveId?: string; pageToken: string | null; pageSize: number }): Promise<GDrivePage>
  /** Throws GoogleError('forbidden') when Google won't export it (over its export size limit). */
  driveDownload(email: string, file: GDriveFile, driveId?: string): Promise<GDownload>
  /** A member of the shared drive who can read all of it (an organizer), to act as. */
  sharedDriveOrganizer(adminEmail: string, driveId: string): Promise<string | null>
  sharedDrivePermissions(adminEmail: string, driveId: string): Promise<GPermission[]>

  // The final pass: what changed since the copy.
  /** Null when Google no longer has history that far back (it keeps about a week): list everything again instead. */
  gmailHistory(email: string, startHistoryId: string, pageToken: string | null): Promise<GHistory | null>
  driveStartToken(email: string, driveId?: string): Promise<string>
  driveChanges(email: string, token: string, driveId?: string): Promise<GChangePage>
  /** The calendars the person owns, primary first. */
  calendarList(email: string): Promise<GCalendar[]>
  /**
   * A page of a calendar's events, deleted ones included. With `syncToken` (from an earlier last page), only what
   * changed since; throws GoogleError 'gone' when that token has expired.
   */
  eventsPage(email: string, calendarId: string, options: { pageToken: string | null; syncToken: string | null }): Promise<GEventPage>
}

/** Google's own file types, exported on download; anything else of Google's (Forms, Sites, …) can't be copied. */
export const GOOGLE_EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: 'pdf' },
}
export const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** "Report.docx" for a Doc called "Report" (not twice if it already ends so). */
export function exportName(name: string, ext: string): string {
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`
}

export type WorkspaceEnv = GoogleKeyEnv & { GOOGLE_MODE: string }

export function workspace(env: WorkspaceEnv): Workspace {
  return env.GOOGLE_MODE === 'fake' ? fakeWorkspace : liveWorkspace(env)
}

// ---------------------------------------------------------------------------------------------------------------

const ADMIN = 'https://admin.googleapis.com/admin'
/** Most pages one listing reads (500 users or 200 groups a page), so a runaway listing can't use every subrequest. */
const MAX_PAGES = 100
/** Drive file counting stops here (1,000 a page); bigger drives are counted while copying. */
const MAX_FILE_PAGES = 50

async function paged<T, P extends { nextPageToken?: string }>(
  token: string,
  base: string,
  pick: (page: P) => T[] | undefined,
  maxPages = MAX_PAGES,
): Promise<T[]> {
  const out: T[] = []
  let pageToken: string | undefined
  for (let i = 0; i < maxPages; i++) {
    const url = new URL(base)
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const page = await googleGet<P>(token, url)
    out.push(...(pick(page) ?? []))
    pageToken = page.nextPageToken
    if (!pageToken) break
  }
  return out
}

function liveWorkspace(env: WorkspaceEnv): Workspace {
  const token = (subject: string, permission: Permission) => accessToken(env, subject, SCOPES[permission])

  /**
   * Each user's mail and Drive size from Google's daily usage report, for the newest day Google has finished. Reports
   * trail by a few days and how far varies, so this starts 2 days back and steps back a day at a time. Google says a
   * day isn't ready either as a warning in the response or as an HTTP 400 ("Data for dates later than … is not yet
   * available"); both mean try the day before.
   */
  const usageReport = async (adminEmail: string): Promise<Map<string, Usage>> => {
    const t = await token(adminEmail, 'directory')
    const MB = 1024 * 1024
    type R = { entity?: { userEmail?: string }; parameters?: { name: string; intValue?: string }[] }
    type Page = { usageReports?: R[]; warnings?: { code: string }[]; nextPageToken?: string }
    for (let daysAgo = 2; daysAgo <= 7; daysAgo++) {
      const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
      const base = `${ADMIN}/reports/v1/usage/users/all/dates/${date}?parameters=accounts:gmail_used_quota_in_mb,accounts:drive_used_quota_in_mb&maxResults=1000`
      let first: Page
      try {
        first = await googleGet<Page>(t, base)
      } catch (err) {
        if (err instanceof GoogleError && err.status === 400 && /not yet available/i.test(err.message)) continue
        throw err
      }
      if (first.warnings?.some((w) => w.code === 'DATA_NOT_AVAILABLE' || w.code === 'PARTIAL_DATA_AVAILABLE') && daysAgo < 7) continue
      const reports = [...(first.usageReports ?? [])]
      if (first.nextPageToken) reports.push(...(await paged<R, Page>(t, `${base}&pageToken=${encodeURIComponent(first.nextPageToken)}`, (p) => p.usageReports)))
      const out = new Map<string, Usage>()
      for (const r of reports) {
        const email = r.entity?.userEmail?.toLowerCase()
        if (!email) continue
        const value = (name: string) => Number(r.parameters?.find((p) => p.name === name)?.intValue ?? 0) * MB
        out.set(email, { mailBytes: value('accounts:gmail_used_quota_in_mb'), driveBytes: value('accounts:drive_used_quota_in_mb') })
      }
      return out
    }
    return new Map()
  }

  return {
    async clientId() {
      return (await serviceAccount(env)).clientId
    },

    async checkScopes(adminEmail) {
      const checks = {} as Record<Permission, boolean>
      let noUser = false
      for (const p of PERMISSIONS) {
        try {
          await token(adminEmail, p)
          checks[p] = true
        } catch (err) {
          if (!(err instanceof GoogleError) || err.code === 'not_configured' || err.code === 'google_error') throw err
          if (err.code === 'no_such_user') noUser = true
          checks[p] = false
        }
      }
      return { checks, noUser }
    },

    async listUsers(adminEmail) {
      const t = await token(adminEmail, 'directory')
      type U = { id: string; primaryEmail: string; name?: { fullName?: string }; suspended?: boolean; archived?: boolean; isAdmin?: boolean; aliases?: string[]; recoveryEmail?: string }
      const users = await paged<U, { users?: U[]; nextPageToken?: string }>(
        t,
        `${ADMIN}/directory/v1/users?customer=my_customer&maxResults=500&projection=full&orderBy=email`,
        (p) => p.users,
      )
      return users.map((u) => ({
        id: u.id,
        email: u.primaryEmail.toLowerCase(),
        name: u.name?.fullName || u.primaryEmail.split('@')[0]!,
        suspended: !!u.suspended || !!u.archived,
        isAdmin: !!u.isAdmin,
        aliases: (u.aliases ?? []).map((a) => a.toLowerCase()),
        recovery: u.recoveryEmail?.toLowerCase() || null,
      }))
    },

    async listDomains(adminEmail) {
      const t = await token(adminEmail, 'directory')
      const res = await googleGet<{ domains?: { domainName: string; isPrimary?: boolean; domainAliases?: { domainAliasName: string }[] }[] }>(
        t,
        `${ADMIN}/directory/v1/customer/my_customer/domains`,
      )
      const out: GDomain[] = []
      for (const d of res.domains ?? []) {
        out.push({ name: d.domainName.toLowerCase(), kind: d.isPrimary ? 'primary' : 'secondary' })
        for (const a of d.domainAliases ?? []) out.push({ name: a.domainAliasName.toLowerCase(), kind: 'alias' })
      }
      return out
    },

    async listGroups(adminEmail) {
      const t = await token(adminEmail, 'directory')
      type G = { id: string; email: string; name?: string; directMembersCount?: string; aliases?: string[] }
      const groups = await paged<G, { groups?: G[]; nextPageToken?: string }>(
        t,
        `${ADMIN}/directory/v1/groups?customer=my_customer&maxResults=200`,
        (p) => p.groups,
      )
      return groups.map((g) => ({
        id: g.id,
        email: g.email.toLowerCase(),
        name: g.name || g.email,
        members: Number(g.directMembersCount ?? 0),
        aliases: (g.aliases ?? []).map((a) => a.toLowerCase()),
      }))
    },

    async groupMemberEmails(adminEmail, groupId) {
      const t = await token(adminEmail, 'directory')
      type M = { email?: string; type?: string }
      const members = await paged<M, { members?: M[]; nextPageToken?: string }>(
        t,
        `${ADMIN}/directory/v1/groups/${encodeURIComponent(groupId)}/members?maxResults=200&includeDerivedMembership=true`,
        (p) => p.members,
      )
      return members.filter((m) => m.email && m.type !== 'GROUP').map((m) => m.email!.toLowerCase())
    },

    async listSharedDrives(adminEmail) {
      const t = await token(adminEmail, 'drive')
      type D = { id: string; name: string }
      const drives = await paged<D, { drives?: D[]; nextPageToken?: string }>(
        t,
        'https://www.googleapis.com/drive/v3/drives?useDomainAdminAccess=true&pageSize=100',
        (p) => p.drives,
      )
      const out: GDrive[] = []
      for (const d of drives) {
        const perms = await paged<{ type: string }, { permissions?: { type: string }[]; nextPageToken?: string }>(
          t,
          `https://www.googleapis.com/drive/v3/files/${d.id}/permissions?supportsAllDrives=true&useDomainAdminAccess=true&pageSize=100&fields=nextPageToken,permissions(type)`,
          (p) => p.permissions,
          5,
        ).catch(() => null)
        out.push({ id: d.id, name: d.name, members: perms ? perms.filter((p) => p.type === 'user').length : null })
      }
      return out
    },

    // Sizes only inform the plan (and are null when unknown), so a failure here never fails discovery.
    async usage(adminEmail) {
      try {
        return await usageReport(adminEmail)
      } catch (err) {
        console.warn(`migration usage report unavailable for ${adminEmail}: ${err instanceof Error ? err.message : String(err)}`)
        return new Map<string, Usage>()
      }
    },

    async countUser(email) {
      const errors: string[] = []
      const part = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
        try {
          return await fn()
        } catch (err) {
          errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
          return null
        }
      }
      const messages = await part('mail', async () => {
        const t = await token(email, 'gmail')
        return (await googleGet<{ messagesTotal?: number }>(t, 'https://gmail.googleapis.com/gmail/v1/users/me/profile')).messagesTotal ?? 0
      })
      const contacts = await part('contacts', async () => {
        const t = await token(email, 'contacts')
        const r = await googleGet<{ totalPeople?: number; totalItems?: number }>(
          t,
          'https://people.googleapis.com/v1/people/me/connections?personFields=metadata&pageSize=1',
        )
        return r.totalPeople ?? r.totalItems ?? 0
      })
      const files = await part('drive', async () => {
        const t = await token(email, 'drive')
        const list = await paged<{ id: string }, { files?: { id: string }[]; nextPageToken?: string }>(
          t,
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent("'me' in owners and trashed = false")}&pageSize=1000&fields=nextPageToken,files(id)`,
          (p) => p.files,
          MAX_FILE_PAGES,
        )
        return list.length
      })
      return { messages, contacts, files, ...(errors.length && { error: errors.join('; ').slice(0, 500) }) }
    },

    async gmailProfile(email) {
      const t = await token(email, 'gmail')
      const p = await googleGet<{ historyId: string; messagesTotal?: number }>(t, `${GMAIL}/profile`)
      return { historyId: p.historyId, messagesTotal: p.messagesTotal ?? 0 }
    },

    async gmailLabels(email) {
      const t = await token(email, 'gmail')
      const r = await googleGet<{ labels?: { id: string; name: string; type?: string }[] }>(t, `${GMAIL}/labels`)
      return (r.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type === 'system' ? 'system' : 'user' }))
    },

    async gmailList(email, options) {
      const t = await token(email, 'gmail')
      const url = new URL(`${GMAIL}/messages`)
      url.searchParams.set('maxResults', String(options.pageSize))
      url.searchParams.set('includeSpamTrash', 'true')
      if (options.q) url.searchParams.set('q', options.q)
      if (options.pageToken) url.searchParams.set('pageToken', options.pageToken)
      const r = await googleGet<{ messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(t, url)
      return { ids: (r.messages ?? []).map((m) => m.id), nextPageToken: r.nextPageToken ?? null, resultSizeEstimate: r.resultSizeEstimate ?? 0 }
    },

    async gmailRaw(email, id, maxBytes) {
      const t = await token(email, 'gmail')
      // Base64 is a third bigger than the message, plus a little JSON around it.
      const m = await googleGet<{ id: string; labelIds?: string[]; internalDate: string; sizeEstimate?: number; raw: string }>(
        t,
        `${GMAIL}/messages/${encodeURIComponent(id)}?format=raw`,
        maxBytes ? { maxBytes: Math.ceil(maxBytes * 1.37) + 4096 } : {},
      )
      const raw = Uint8Array.from(atob(m.raw.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      return { id: m.id, labelIds: m.labelIds ?? [], internalDate: Number(m.internalDate), sizeEstimate: m.sizeEstimate ?? raw.byteLength, raw }
    },

    async contactsPage(email, which, pageToken) {
      const t = await token(email, 'contacts')
      const url =
        which === 'connections'
          ? new URL(`${PEOPLE}/people/me/connections?personFields=${PERSON_FIELDS}&pageSize=1000`)
          : new URL(`${PEOPLE}/otherContacts?readMask=names,emailAddresses,phoneNumbers&pageSize=1000`)
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const r = await googleGet<{ connections?: ApiPerson[]; otherContacts?: ApiPerson[]; nextPageToken?: string; totalPeople?: number; totalSize?: number }>(t, url)
      const list = (which === 'connections' ? r.connections : r.otherContacts) ?? []
      return { contacts: list.map(toContact), nextPageToken: r.nextPageToken ?? null, total: r.totalPeople ?? r.totalSize ?? list.length }
    },

    async contactGroups(email) {
      const t = await token(email, 'contacts')
      const r = await googleGet<{ contactGroups?: { resourceName: string; name?: string; formattedName?: string; groupType?: string }[] }>(
        t,
        `${PEOPLE}/contactGroups?pageSize=1000`,
      )
      return new Map(
        (r.contactGroups ?? []).filter((g) => g.groupType === 'USER_CONTACT_GROUP').map((g) => [g.resourceName, g.formattedName ?? g.name ?? '']),
      )
    },

    async fetchPhoto(url) {
      const res = await fetch(url)
      if (!res.ok) return null
      return { bytes: await res.arrayBuffer(), type: res.headers.get('Content-Type') ?? 'image/jpeg' }
    },

    async driveList(email, { folders, driveId, pageToken, pageSize }) {
      const t = await token(email, 'drive')
      const kind = folders ? `mimeType = '${FOLDER_MIME}'` : `mimeType != '${FOLDER_MIME}'`
      const url = new URL(`${DRIVE}/files`)
      url.searchParams.set('pageSize', String(pageSize))
      url.searchParams.set('fields', FILE_FIELDS)
      if (driveId) {
        url.searchParams.set('q', `trashed = false and ${kind}`)
        url.searchParams.set('corpora', 'drive')
        url.searchParams.set('driveId', driveId)
        url.searchParams.set('includeItemsFromAllDrives', 'true')
        url.searchParams.set('supportsAllDrives', 'true')
      } else {
        url.searchParams.set('q', `'me' in owners and trashed = false and ${kind}`)
      }
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      const r = await googleGet<{ files?: ApiFile[]; nextPageToken?: string }>(t, url)
      return { files: (r.files ?? []).map(toFile), nextPageToken: r.nextPageToken ?? null }
    },

    async driveDownload(email, file) {
      const t = await token(email, 'drive')
      const exp = GOOGLE_EXPORTS[file.mimeType]
      if (exp) {
        // Google exports up to 10 MB this way; bigger ones come back 403 exportSizeLimitExceeded.
        const res = await googleStream(t, `${DRIVE}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exp.mime)}`)
        return { body: res.body!, size: null, contentType: exp.mime, name: exportName(file.name, exp.ext), md5: null }
      }
      const res = await googleStream(t, `${DRIVE}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`)
      return { body: res.body!, size: file.size, contentType: file.mimeType || 'application/octet-stream', name: file.name, md5: file.md5 }
    },

    async sharedDriveOrganizer(adminEmail, driveId) {
      const perms = await this.sharedDrivePermissions(adminEmail, driveId)
      return perms.find((p) => p.type === 'user' && p.role === 'organizer' && p.email)?.email ?? null
    },

    async gmailHistory(email, startHistoryId, pageToken) {
      const t = await token(email, 'gmail')
      const url = new URL(`${GMAIL}/history`)
      url.searchParams.set('startHistoryId', startHistoryId)
      url.searchParams.set('maxResults', '500')
      for (const type of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) url.searchParams.append('historyTypes', type)
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      type M = { message: { id: string; labelIds?: string[] } }
      type H = { messagesAdded?: M[]; messagesDeleted?: M[]; labelsAdded?: M[]; labelsRemoved?: M[] }
      let r: { history?: H[]; nextPageToken?: string; historyId: string }
      try {
        r = await googleGet(t, url)
      } catch (err) {
        if (err instanceof GoogleError && err.code === 'not_found') return null
        throw err
      }
      const added = new Set<string>()
      const deleted = new Set<string>()
      const labelled = new Map<string, string[]>()
      for (const h of r.history ?? []) {
        for (const m of h.messagesAdded ?? []) added.add(m.message.id)
        for (const m of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) labelled.set(m.message.id, m.message.labelIds ?? [])
        for (const m of h.messagesDeleted ?? []) deleted.add(m.message.id)
      }
      for (const id of deleted) {
        added.delete(id)
        labelled.delete(id)
      }
      return { added: [...added], labelled: [...labelled].map(([id, labelIds]) => ({ id, labelIds })), deleted: [...deleted], nextPageToken: r.nextPageToken ?? null, historyId: r.historyId }
    },

    async driveStartToken(email, driveId) {
      const t = await token(email, 'drive')
      const url = new URL(`${DRIVE}/changes/startPageToken?supportsAllDrives=true`)
      if (driveId) url.searchParams.set('driveId', driveId)
      return (await googleGet<{ startPageToken: string }>(t, url)).startPageToken
    },

    async driveChanges(email, pageToken, driveId) {
      const t = await token(email, 'drive')
      const url = new URL(`${DRIVE}/changes`)
      url.searchParams.set('pageToken', pageToken)
      url.searchParams.set('pageSize', '100')
      url.searchParams.set('supportsAllDrives', 'true')
      url.searchParams.set('includeItemsFromAllDrives', 'true')
      url.searchParams.set('fields', `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS.replace(/^nextPageToken,files\((.*)\)$/, '$1')},trashed,owners(me)))`)
      if (driveId) url.searchParams.set('driveId', driveId)
      type C = { fileId: string; removed?: boolean; file?: ApiFile & { trashed?: boolean; owners?: { me?: boolean }[] } }
      const r = await googleGet<{ changes?: C[]; nextPageToken?: string; newStartPageToken?: string }>(t, url)
      return {
        // Trashed counts as removed, and in My Drive only files they own are theirs to copy.
        changes: (r.changes ?? []).map((c) => {
          const gone = !!c.removed || !c.file || !!c.file.trashed || (!driveId && !c.file.owners?.some((o) => o.me))
          return { fileId: c.fileId, removed: gone, file: gone ? null : toFile(c.file!) }
        }),
        nextPageToken: r.nextPageToken ?? null,
        newStartPageToken: r.newStartPageToken ?? null,
      }
    },

    async calendarList(email) {
      const t = await token(email, 'calendar')
      type Item = { id: string; summary?: string; summaryOverride?: string; primary?: boolean; timeZone?: string; accessRole?: string }
      const items = await paged<Item, { items?: Item[]; nextPageToken?: string }>(
        t,
        `${CALENDAR}/users/me/calendarList?minAccessRole=owner&showHidden=true&maxResults=250`,
        (p) => p.items,
      )
      return items
        .filter((c) => c.accessRole === 'owner' && !/#(holiday|contacts)@group\.v\.calendar\.google\.com$/.test(c.id))
        .map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || 'Calendar', primary: !!c.primary, timeZone: c.timeZone ?? null }))
        .sort((a, b) => Number(b.primary) - Number(a.primary))
    },

    async eventsPage(email, calendarId, options) {
      const t = await token(email, 'calendar')
      const url = new URL(`${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events`)
      url.searchParams.set('maxResults', '250')
      url.searchParams.set('showDeleted', 'true')
      url.searchParams.set('singleEvents', 'false')
      if (options.syncToken) url.searchParams.set('syncToken', options.syncToken)
      if (options.pageToken) url.searchParams.set('pageToken', options.pageToken)
      const r = await googleGet<{ items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string }>(t, url)
      return { events: r.items ?? [], nextPageToken: r.nextPageToken ?? null, nextSyncToken: r.nextSyncToken ?? null }
    },

    async sharedDrivePermissions(adminEmail, driveId) {
      const t = await token(adminEmail, 'drive')
      const all = await paged<NonNullable<ApiFile['permissions']>[number], { permissions?: NonNullable<ApiFile['permissions']>; nextPageToken?: string }>(
        t,
        `${DRIVE}/files/${driveId}/permissions?supportsAllDrives=true&useDomainAdminAccess=true&pageSize=100&fields=nextPageToken,permissions(type,role,emailAddress,domain)`,
        (p) => p.permissions,
        10,
      )
      return all.map(toPermission)
    },
  }
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const DRIVE = 'https://www.googleapis.com/drive/v3'
const FILE_FIELDS = 'nextPageToken,files(id,name,mimeType,parents,size,md5Checksum,permissions(type,role,emailAddress,domain))'

type ApiFile = {
  id: string
  name: string
  mimeType: string
  parents?: string[]
  size?: string
  md5Checksum?: string
  permissions?: { type: GPermission['type']; role: string; emailAddress?: string; domain?: string }[]
}
const toPermission = (p: NonNullable<ApiFile['permissions']>[number]): GPermission => ({
  type: p.type,
  role: p.role,
  email: p.emailAddress?.toLowerCase() ?? null,
  domain: p.domain?.toLowerCase() ?? null,
})
const toFile = (f: ApiFile): GDriveFile => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  parents: f.parents ?? [],
  size: f.size ? Number(f.size) : null,
  md5: f.md5Checksum ?? null,
  permissions: (f.permissions ?? []).map(toPermission),
})

/** A streamed GET as `token`, retried like googleGet before the body is read. */
async function googleStream(token: string, url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok && res.body) return res
    const text = await res.text()
    const limited = res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(text))
    if ((limited || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      continue
    }
    if (limited) throw new GoogleError('rate_limited', 'Google is limiting how fast xstate can read.', res.status)
    if (res.status === 403) throw new GoogleError('forbidden', `Google refused the download: ${text.slice(0, 200)}`, res.status)
    if (res.status === 404) throw new GoogleError('not_found', 'The file is gone from Google', res.status)
    throw new GoogleError('google_error', `Google returned HTTP ${res.status}: ${text.slice(0, 200)}`, res.status)
  }
}
const PEOPLE = 'https://people.googleapis.com/v1'
const CALENDAR = 'https://www.googleapis.com/calendar/v3'
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,addresses,birthdays,biographies,photos,memberships'

type ApiPerson = {
  resourceName: string
  names?: { displayName?: string }[]
  emailAddresses?: { value?: string }[]
  phoneNumbers?: { value?: string }[]
  organizations?: { name?: string; title?: string }[]
  addresses?: { formattedValue?: string }[]
  birthdays?: { date?: { year?: number; month?: number; day?: number } }[]
  biographies?: { value?: string }[]
  photos?: { url?: string; default?: boolean }[]
  memberships?: { contactGroupMembership?: { contactGroupResourceName?: string } }[]
}

function toContact(p: ApiPerson): GContact {
  const d = p.birthdays?.[0]?.date
  const pad = (n?: number) => String(n ?? 0).padStart(2, '0')
  return {
    id: p.resourceName,
    name: p.names?.[0]?.displayName ?? null,
    emails: (p.emailAddresses ?? []).map((e) => e.value?.toLowerCase()).filter((e): e is string => !!e),
    phones: (p.phoneNumbers ?? []).map((x) => x.value).filter((x): x is string => !!x),
    company: p.organizations?.[0]?.name ?? null,
    title: p.organizations?.[0]?.title ?? null,
    addresses: (p.addresses ?? []).map((a) => a.formattedValue).filter((a): a is string => !!a),
    birthday: d?.month && d?.day ? `${d.year ? `${d.year}-` : ''}${pad(d.month)}-${pad(d.day)}` : null,
    notes: p.biographies?.[0]?.value ?? null,
    photoUrl: p.photos?.find((ph) => ph.url && !ph.default)?.url ?? null,
    labels: (p.memberships ?? []).map((m) => m.contactGroupMembership?.contactGroupResourceName).filter((x): x is string => !!x),
  }
}
