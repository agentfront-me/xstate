// Copying one person's Gmail into their xstate mailbox, one page (100 messages) per queue job. See the Workspace
// Migration Plan, "Gmail to Stalwart".
//
// Each job: lists the next page of message ids (spam and trash included), claims the ones not copied yet in the
// MigrationStore, fetches them raw, uploads them to Stalwart and imports them with their folders, read/starred
// state and original received time, records what they became, updates the counters, queues a mail sync (so their
// attachments reach Storage) and queues the next page. A user has one chain of jobs at a time (mail_chain); a
// resume starts a new chain and the old one stops at its next step.

import * as mailboxesDb from '../db/mailboxes'
import * as migrationsDb from '../db/migrations'
import type { MigrationUserRow } from '../db/migrations'
import { enqueue as enqueueMailSync } from '../jobs/mail-sync'
import * as jmap from '../mailserver/stalwart/mail'
import type { FolderRole, JmapFolder } from '../mailserver/stalwart/mail'
import { GoogleError } from './google/auth'
import { workspace, type GLabel } from './google/workspace'
import { enqueueMigrationJobs, HELD_RETRY_SECONDS } from './jobs'
import { placement, rangeQuery } from './mail-rules'
import { migrationStore } from './store'

export type MailJob = { kind: 'mail'; migrationId: string; googleId: string; chain: number }

/** Message ids listed per job. */
const PAGE_SIZE = 100
/** Messages imported per Email/import call. */
const IMPORT_BATCH = 25
/** Raw messages fetched from Gmail at once. Each is held in memory until uploaded, so this stays small. */
const FETCH_CONCURRENCY = 4

// ---------------------------------------------------------------------------------------------------------------
// Folders

export type Folders = { roles: Map<FolderRole, string>; labels: Map<string, string> }

/**
 * The account's role folders (creating Archive if it has none), and a folder for each Gmail user label: nested
 * labels ("Clients/Acme") become nested folders. Label → folder is remembered in the MigrationStore, so later pages
 * don't look again.
 */
export async function folders(env: Env, organizationId: string, googleId: string, accountId: string, labels: GLabel[]): Promise<Folders> {
  const store = migrationStore(env, organizationId)
  let list: JmapFolder[] = (await jmap.getFolders(env, [accountId])).get(accountId) ?? []
  const roles = new Map<FolderRole, string>()
  for (const f of list) if (f.role) roles.set(f.role as FolderRole, f.id)
  if (!roles.has('archive')) roles.set('archive', await jmap.createFolder(env, accountId, 'Archive', 'archive'))

  const known = new Map(Object.entries(await store.map('label', googleId)))
  const user = labels.filter((l) => l.type === 'user').sort((a, b) => a.name.localeCompare(b.name))
  const created: { sourceId: string; targetId: string }[] = []
  for (const label of user) {
    if (known.has(label.id)) continue
    let parentId: string | null = null
    for (const part of label.name.split('/').filter(Boolean)) {
      const existing: JmapFolder | undefined = list.find((f) => f.name === part && (f.parentId ?? null) === parentId)
      if (existing) {
        parentId = existing.id
        continue
      }
      const id = await jmap.createChildFolder(env, accountId, part, parentId)
      list = [...list, { id, name: part, role: null, parentId, unreadEmails: 0, totalEmails: 0 }]
      parentId = id
    }
    if (parentId) {
      known.set(label.id, parentId)
      created.push({ sourceId: label.id, targetId: parentId })
    }
  }
  if (created.length) await store.record('label', googleId, created)
  return { roles, labels: known }
}

// ---------------------------------------------------------------------------------------------------------------
// The job

let limits: Promise<jmap.MailLimits> | null = null

/** The mail server's size limits, asked once per isolate. */
export const mailLimits = (env: Env) => (limits ??= jmap.getLimits(env))

/** Thrown to stop a user's chain with something an admin has to look at. */
class UserIssue extends Error {
  readonly issue: 'quota' | 'suspended' | 'error'
  constructor(issue: 'quota' | 'suspended' | 'error', message: string) {
    super(message)
    this.issue = issue
  }
}

export async function copyMailPage(env: Env, job: MailJob): Promise<void> {
  const m = await migrationsDb.find(env.DB, job.migrationId)
  if (!m || m.status === 'cancelled' || m.paused_at || m.access_lost_at) return
  const u = await migrationsDb.findUser(env.DB, job.migrationId, job.googleId)
  if (!u || u.mail_chain !== job.chain || !u.copy_mail || !u.mailbox_id || u.mail_state === 'done' || u.mail_state === 'attention') return
  const mailbox = await mailboxesDb.find(env.DB, u.mailbox_id)
  if (!mailbox) return setIssue(env, u, 'error', 'The xstate mailbox for this person was deleted')

  try {
    await copyPage(env, job, m.organization_id, m.mail_range, u, mailbox.stalwart_id)
    // Attachments of what was just imported go to Storage, like any new mail.
    await enqueueMailSync(env, [{ mailboxId: mailbox.id, reason: 'import' }])
  } catch (err) {
    if (err instanceof UserIssue) return setIssue(env, u, err.issue, err.message)
    if (err instanceof GoogleError && err.code === 'not_authorized') {
      // The admin removed (or narrowed) the delegation: everything pauses until it's back.
      await migrationsDb.update(env.DB, job.migrationId, { access_lost_at: new Date().toISOString() }).run()
      return
    }
    if (err instanceof GoogleError && err.code === 'no_such_user') {
      const why = u.suspended
        ? 'Google won’t let xstate read a suspended account. Restore it in Google for the copy (it won’t become a member), then try again, or skip this person.'
        : 'Google no longer knows this account (deleted or renamed?).'
      return setIssue(env, u, 'suspended', why)
    }
    if (err instanceof GoogleError && err.code === 'rate_limited') {
      await env.DB.prepare('UPDATE migration_users SET mail_note = ?, mail_updated_at = ? WHERE migration_id = ? AND google_id = ?')
        .bind('slowed', new Date().toISOString(), u.migration_id, u.google_id)
        .run()
    }
    throw err
  }
}

async function copyPage(env: Env, job: MailJob, organizationId: string, range: 'all' | '5y' | '3y' | '1y', u: MigrationUserRow, accountId: string) {
  const ws = workspace(env)
  const store = migrationStore(env, organizationId)
  const q = rangeQuery(range)
  const now = () => new Date().toISOString()

  // First page: where Gmail stands now, so the final pass after the switch can copy only what changed.
  let total = u.mail_total
  if (!u.mail_state) {
    const profile = await ws.gmailProfile(u.email)
    total = profile.messagesTotal
    await env.DB.prepare(
      "UPDATE migration_users SET history_id = ?, mail_total = ?, mail_state = 'copying', mail_updated_at = ? WHERE migration_id = ? AND google_id = ?",
    )
      .bind(profile.historyId, total, now(), u.migration_id, u.google_id)
      .run()
  }

  const [labels, page] = await Promise.all([ws.gmailLabels(u.email), ws.gmailList(u.email, { q, pageToken: u.mail_cursor, pageSize: PAGE_SIZE })])
  // With a date range Gmail's total counts everything; its estimate for the search is closer.
  if (q && !u.mail_cursor) total = page.resultSizeEstimate
  const place = await folders(env, organizationId, u.google_id, accountId, labels)
  const userLabels = new Set(place.labels.keys())
  const max = (await mailLimits(env)).maxSizeUpload

  const claim = `${job.migrationId}:${u.google_id}:${job.chain}:${u.mail_cursor ?? 'first'}`
  const { mine: ids, held } = await store.claim('message', u.google_id, page.ids, claim)

  const began = Date.now()
  const imported = await importIds(env, { store, email: u.email, googleId: u.google_id, accountId, place, max }, ids, claim)
  // Messages and bytes a second for one mailbox: Gmail's per-user limit or Stalwart's import speed, whichever binds.
  console.log(JSON.stringify({ event: 'migration_mail_page', migrationId: job.migrationId, messages: imported.copied, bytes: imported.bytes, ms: Date.now() - began }))
  if (imported.full) {
    await saveProgress(env, u, store, total, u.mail_cursor)
    throw new UserIssue('quota', 'The xstate mailbox is full: its quota is smaller than this Gmail account. Mail copying stopped here.')
  }

  // Messages held by another job's claim: come back to this page later instead of moving past them.
  if (held) {
    await saveProgress(env, u, store, total, u.mail_cursor)
    await enqueueMigrationJobs(env, [{ kind: 'mail', migrationId: job.migrationId, googleId: u.google_id, chain: job.chain }], HELD_RETRY_SECONDS)
    return
  }
  await saveProgress(env, u, store, total, page.nextPageToken)
  if (page.nextPageToken) {
    await enqueueMigrationJobs(env, [{ kind: 'mail', migrationId: job.migrationId, googleId: u.google_id, chain: job.chain }])
  } else {
    await env.DB.prepare("UPDATE migration_users SET mail_state = 'done', mail_note = NULL, mail_updated_at = ? WHERE migration_id = ? AND google_id = ?")
      .bind(now(), u.migration_id, u.google_id)
      .run()
  }
}

export type ImportContext = {
  store: ReturnType<typeof migrationStore>
  email: string
  googleId: string
  accountId: string
  place: Folders
  max: number
}

/**
 * Fetches claimed Gmail messages, uploads and imports them, and records what they became (or why not). Stops at a
 * full mailbox (`full`), letting go of what it hadn't copied. Used by the copy and the final pass.
 */
export async function importIds(env: Env, c: ImportContext, ids: string[], claim: string): Promise<{ copied: number; bytes: number; full: boolean }> {
  const ws = workspace(env)
  const userLabels = new Set(c.place.labels.keys())
  let total = 0
  let bytes = 0
  for (let i = 0; i < ids.length; i += IMPORT_BATCH) {
    const chunk = ids.slice(i, i + IMPORT_BATCH)
    const ready: { sourceId: string; item: jmap.ImportEmail }[] = []
    const skipped: { sourceId: string; reason: string; detail?: string }[] = []
    await inBatches(chunk, FETCH_CONCURRENCY, async (id) => {
      const msg = await ws.gmailRaw(c.email, id)
      const where = placement(msg.labelIds, userLabels)
      if ('skip' in where) return void skipped.push({ sourceId: id, reason: where.skip })
      if (msg.raw.byteLength > c.max) {
        return void skipped.push({ sourceId: id, reason: 'too_large', detail: `${Math.round(msg.raw.byteLength / 1e6)} MB; the mail server takes up to ${Math.round(c.max / 1e6)} MB` })
      }
      const blob = await jmap.uploadBlob(env, c.accountId, msg.raw.slice().buffer as ArrayBuffer, 'message/rfc822', msg.raw.byteLength)
      bytes += msg.raw.byteLength
      ready.push({ sourceId: id, item: { blobId: blob.blobId, folderIds: folderIdsFor(c.place, where.folders), keywords: where.keywords, receivedAt: new Date(msg.internalDate).toISOString() } })
    })

    const results = await jmap.importEmails(env, c.accountId, ready.map((r) => r.item))
    const copied: { sourceId: string; targetId: string }[] = []
    let full = false
    results.forEach((r, k) => {
      const sourceId = ready[k]!.sourceId
      if (r.ok) copied.push({ sourceId, targetId: r.id })
      else if (r.type === 'overQuota') full = true
      else skipped.push({ sourceId, reason: 'import_failed', detail: r.description })
    })
    if (copied.length) await c.store.record('message', c.googleId, copied)
    if (skipped.length) await c.store.skip('message', c.googleId, skipped)
    total += copied.length
    if (full) {
      // Let go of what this job claimed but didn't copy, so the copy picks them up once there's room.
      await c.store.release('message', c.googleId, ids.slice(i), claim)
      return { copied: total, bytes, full: true }
    }
  }
  return { copied: total, bytes, full: false }
}

/** xstate folder ids for a placement; Archive when none of them exist. */
export function folderIdsFor(place: Folders, folders: (FolderRole | { label: string })[]): string[] {
  const ids = [...new Set(folders.map((f) => (typeof f === 'string' ? place.roles.get(f) : place.labels.get(f.label))).filter((x): x is string => !!x))]
  return ids.length ? ids : [place.roles.get('archive')!]
}

async function saveProgress(
  env: Env,
  u: MigrationUserRow,
  store: ReturnType<typeof migrationStore>,
  total: number | null,
  cursor: string | null,
) {
  const counts = await store.counts('message', u.google_id)
  await env.DB.prepare(
    `UPDATE migration_users SET mail_done = ?, mail_skipped = ?, mail_total = MAX(COALESCE(?, 0), ?), mail_cursor = ?,
       mail_note = NULL, mail_updated_at = ? WHERE migration_id = ? AND google_id = ?`,
  )
    .bind(counts.copied, counts.skipped, total, counts.copied + counts.skipped, cursor, new Date().toISOString(), u.migration_id, u.google_id)
    .run()
}

async function setIssue(env: Env, u: MigrationUserRow, issue: 'quota' | 'suspended' | 'error', message: string) {
  await env.DB.prepare(
    "UPDATE migration_users SET mail_state = 'attention', mail_issue = ?, mail_note = ?, mail_updated_at = ? WHERE migration_id = ? AND google_id = ?",
  )
    .bind(issue, message, new Date().toISOString(), u.migration_id, u.google_id)
    .run()
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn))
}
