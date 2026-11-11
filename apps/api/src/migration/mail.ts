// Copying one person's Gmail into their xstate mailbox, a few minutes of pages (500 messages each) per queue job. See
// the Workspace Migration Plan, "Gmail to Stalwart".
//
// Each page: lists the next message ids (spam and trash included), claims the ones not copied yet in the
// MigrationStore, asks Gmail how big they are, then a pool of workers fetches each raw message (streamed, within a
// per-isolate byte budget), uploads it to Stalwart, and imports them 25 at a time with their folders, read/starred
// state and original received time, recording what they became. Progress is saved after every page. When the job's
// time is up it queues the next one, and once at the end it queues a mail sync (so attachments reach Storage). A
// user has one chain of jobs at a time (mail_chain); a resume starts a new chain and the old one stops at its next
// page.
//
// A message that keeps killing the job (the Worker running out of memory or time, which no catch sees) is found by
// the MigrationStore's attempt counts: messages in flight when a job died are copied one at a time on the next run,
// and one that was alone when a job died is skipped and reported.

import * as mailboxesDb from '../db/mailboxes'
import * as migrationsDb from '../db/migrations'
import type { MigrationUserRow } from '../db/migrations'
import { enqueue as enqueueMailSync } from '../jobs/mail-sync'
import * as jmap from '../mailserver/stalwart/mail'
import type { FolderRole, JmapFolder } from '../mailserver/stalwart/mail'
import { GoogleError } from './google/auth'
import { workspace, type GLabel } from './google/workspace'
import { finishIfDone } from './final'
import { enqueueMigrationJobs, HELD_RETRY_SECONDS } from './jobs'
import { ByteBudget, runPool, sleep } from './copy-pool'
import { placement, rangeQuery } from './mail-rules'
import { migrationStore, type Problem } from './store'

export type MailJob = { kind: 'mail'; migrationId: string; googleId: string; chain: number }

/** Message ids listed per page: Gmail's most. */
const PAGE_SIZE = 500
/** How long a job keeps taking pages before it queues the next job. Well inside a queue job's 15 minutes. */
const JOB_BUDGET_MS = 4 * 60_000
/** Messages imported per Email/import call. */
const IMPORT_BATCH = 25
/** Messages fetched and uploaded at once, at most. Google allows about 50 a second per user. */
const FETCH_CONCURRENCY = 12
/** Retries of one message Google rate-limited, after googleGet's own, before the job gives up for now. */
const THROTTLE_RETRIES = 4
/**
 * Bytes of messages in flight per isolate. A message costs about its size while it's read and uploaded, and Workers
 * may run a few jobs in one isolate, so this stays well under the 128 MB limit.
 */
const budget = new ByteBudget(32 * 1024 * 1024)
/** What a message of unknown size reserves. */
const UNKNOWN_SIZE = 4 * 1024 * 1024
/** Attempts counted per call, ahead of the workers. Up to this many become suspects when a job dies. */
const ATTEMPT_WINDOW = 25
/**
 * Unfinished attempts at which a message is skipped. The first comes from a window that was in flight when a job
 * died; the second from being copied alone (as a suspect) when a job died again.
 */
const SKIP_AT_ATTEMPTS = 2

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

let limits: jmap.MailLimits | null = null

/**
 * The mail server's size limits, asked once per isolate. Only the answer is kept, never the request in flight, so
 * one stalled or failed lookup can't leave later jobs waiting on it (see maxCalls in mailserver/stalwart/mail.ts).
 */
export async function mailLimits(env: Env): Promise<jmap.MailLimits> {
  limits ??= await jmap.getLimits(env)
  return limits
}

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
  const deadline = Date.now() + JOB_BUDGET_MS

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

  // Folders and limits once per job, not per page.
  const place = await folders(env, organizationId, u.google_id, accountId, await ws.gmailLabels(u.email))
  const max = (await mailLimits(env)).maxSizeUpload
  const next = () => enqueueMigrationJobs(env, [{ kind: 'mail', migrationId: job.migrationId, googleId: u.google_id, chain: job.chain }])

  let cursor = u.mail_cursor
  for (;;) {
    const began = Date.now()
    const page = await ws.gmailList(u.email, { q, pageToken: cursor, pageSize: PAGE_SIZE })
    // With a date range Gmail's total counts everything; its estimate for the search is closer.
    if (q && !cursor) total = page.resultSizeEstimate

    const claim = `${job.migrationId}:${u.google_id}:${job.chain}:${cursor ?? 'first'}`
    const { mine: ids, held } = await store.claim('message', u.google_id, page.ids, claim)
    const imported = await importIds(env, { store, email: u.email, googleId: u.google_id, accountId, place, max }, ids, claim)
    const ms = Date.now() - began
    // Messages and bytes a second for one mailbox: Gmail's per-user limit or Stalwart's import speed, whichever binds.
    console.log(JSON.stringify({ event: 'migration_mail_page', migrationId: job.migrationId, messages: imported.copied, skipped: imported.skipped, bytes: imported.bytes, ms }))
    const rate = ids.length ? (imported.copied + imported.skipped) / Math.max(ms / 1000, 1) : null
    if (imported.full) {
      await saveProgress(env, u, store, total, cursor, rate)
      throw new UserIssue('quota', 'The xstate mailbox is full: its quota is smaller than this Gmail account. Mail copying stopped here.')
    }

    // Messages held by another job's claim: come back to this page later instead of moving past them.
    if (held) {
      await saveProgress(env, u, store, total, cursor, rate)
      await enqueueMigrationJobs(env, [{ kind: 'mail', migrationId: job.migrationId, googleId: u.google_id, chain: job.chain }], HELD_RETRY_SECONDS)
      return
    }
    await saveProgress(env, u, store, total, page.nextPageToken, rate)
    if (!page.nextPageToken) {
      await env.DB.prepare("UPDATE migration_users SET mail_state = 'done', mail_note = NULL, mail_updated_at = ? WHERE migration_id = ? AND google_id = ?")
        .bind(now(), u.migration_id, u.google_id)
        .run()
      await endFinalMail(env, u)
      return
    }
    cursor = page.nextPageToken
    if (Date.now() > deadline) return next()
    // Paused, cancelled or restarted since this job began: this chain stops here.
    if (!(await stillMine(env, job))) return
  }
}

/** Whether this job's chain is still the one copying this person's mail. */
async function stillMine(env: Env, job: MailJob): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT u.mail_chain, u.mail_state, m.status, m.paused_at, m.access_lost_at FROM migration_users u JOIN migrations m ON m.id = u.migration_id
     WHERE u.migration_id = ? AND u.google_id = ?`,
  )
    .bind(job.migrationId, job.googleId)
    .first<{ mail_chain: number; mail_state: string | null; status: string; paused_at: string | null; access_lost_at: string | null }>()
  return !!row && row.mail_chain === job.chain && row.mail_state === 'copying' && row.status !== 'cancelled' && !row.paused_at && !row.access_lost_at
}

/** A final pass that had to list the mailbox again (./final.ts) is over for this person once that copy is. */
async function endFinalMail(env: Env, u: MigrationUserRow) {
  if (u.final_mail !== 'running') return
  await env.DB.prepare("UPDATE migration_users SET final_mail = 'done' WHERE migration_id = ? AND google_id = ? AND final_mail = 'running'").bind(u.migration_id, u.google_id).run()
  await finishIfDone(env, u.migration_id)
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
export async function importIds(
  env: Env,
  c: ImportContext,
  ids: string[],
  claim: string,
): Promise<{ copied: number; skipped: number; bytes: number; full: boolean }> {
  if (!ids.length) return { copied: 0, skipped: 0, bytes: 0, full: false }
  const ws = workspace(env)
  const userLabels = new Set(c.place.labels.keys())
  const mb = (n: number) => Math.round(n / 1e6)
  const tooLarge = (bytes: number): Problem['detail'] => `${mb(bytes)} MB; the mail server takes up to ${mb(c.max)} MB`

  // Messages in flight when an earlier job died: one that was alone then is skipped, the others go one at a time.
  const deaths = await c.store.attempts('message', c.googleId, ids)
  const skipped: Problem[] = []
  const suspects: string[] = []
  const rest: string[] = []
  for (const id of ids) {
    const n = deaths[id] ?? 0
    if (n >= SKIP_AT_ATTEMPTS) skipped.push({ sourceId: id, reason: 'kept_failing', detail: 'Copying it stopped the import twice (the Worker ran out of memory or time)' })
    else if (n > 0) suspects.push(id)
    else rest.push(id)
  }
  const sizes = await ws.gmailSizes(c.email, [...suspects, ...rest])
  for (const list of [suspects, rest]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const size = sizes.get(list[i]!)
      if (size !== undefined && size > c.max) skipped.push({ sourceId: list.splice(i, 1)[0]!, reason: 'too_large', detail: tooLarge(size) })
    }
  }

  let copied = 0
  let skippedCount = 0
  let bytes = 0
  let full = false
  /** An import or record failed: the job is failing, so stop downloading. */
  let broken = false
  const finished = new Set<string>()
  const attempted = new Set<string>()
  let ready: { sourceId: string; item: jmap.ImportEmail }[] = []
  // Imports and records run one after another, alongside the downloads.
  let writes: Promise<void> = Promise.resolve()

  const flushSkipped = async () => {
    if (!skipped.length) return
    const rows = skipped.splice(0)
    await c.store.skip('message', c.googleId, rows)
    for (const r of rows) finished.add(r.sourceId)
    skippedCount += rows.length
  }
  const flush = (all: boolean) => {
    while (ready.length >= IMPORT_BATCH || (all && ready.length)) {
      const batch = ready.slice(0, IMPORT_BATCH)
      ready = ready.slice(IMPORT_BATCH)
      writes = writes.then(async () => {
        if (full) return
        const results = await jmap.importEmails(env, c.accountId, batch.map((r) => r.item)).catch((err) => {
          broken = true
          throw err
        })
        const done: { sourceId: string; targetId: string }[] = []
        results.forEach((r, k) => {
          const sourceId = batch[k]!.sourceId
          if (r.ok) done.push({ sourceId, targetId: r.id })
          else if (r.type === 'overQuota') full = true
          else skipped.push({ sourceId, reason: 'import_failed', detail: r.description })
        })
        if (done.length) await c.store.record('message', c.googleId, done)
        for (const d of done) finished.add(d.sourceId)
        copied += done.length
        await flushSkipped()
      })
    }
    return writes
  }

  // Attempts are counted a window ahead of the workers (one call per window), so a job that dies leaves at most a
  // window of suspects. Suspects themselves are counted one by one.
  let counted = 0
  let counting: Promise<void> = Promise.resolve()
  const count = (list: string[], index: number, window: number) => {
    counting = counting.then(async () => {
      while (counted <= index) {
        const batch = list.slice(counted, counted + window)
        counted += batch.length
        await c.store.attempt('message', c.googleId, batch, 1)
        for (const id of batch) attempted.add(id)
      }
    })
    return counting
  }

  const copyOne = async (id: string, solo: boolean, ctl: { slowDown(): void; readonly stopping: boolean; stop(): void }) => {
    if (full || broken || ctl.stopping) return
    const size = sizes.get(id)
    const release = await budget.acquire(solo ? budget.limit : (size ?? UNKNOWN_SIZE))
    try {
      let msg
      for (let tries = 0; ; tries++) {
        try {
          msg = await ws.gmailRaw(c.email, id, { maxBytes: c.max, sizeHint: size })
          break
        } catch (err) {
          if (err instanceof GoogleError && err.code === 'too_large') return void skipped.push({ sourceId: id, reason: 'too_large', detail: `over ${mb(c.max)} MB, the most the mail server takes` })
          if (err instanceof GoogleError && err.code === 'not_found') return void skipped.push({ sourceId: id, reason: 'deleted', detail: 'Deleted in Gmail while it was being copied' })
          if (err instanceof GoogleError && err.code === 'rate_limited' && tries < THROTTLE_RETRIES && !ctl.stopping) {
            ctl.slowDown()
            await sleep(2000 * 2 ** tries + Math.random() * 1000)
            continue
          }
          throw err
        }
      }
      const where = placement(msg.labelIds, userLabels)
      if ('skip' in where) return void skipped.push({ sourceId: id, reason: where.skip })
      if (msg.raw.byteLength > c.max) return void skipped.push({ sourceId: id, reason: 'too_large', detail: tooLarge(msg.raw.byteLength) })
      const blob = await jmap.uploadBlob(env, c.accountId, msg.raw, 'message/rfc822', msg.raw.byteLength)
      bytes += msg.raw.byteLength
      ready.push({ sourceId: id, item: { blobId: blob.blobId, folderIds: folderIdsFor(c.place, where.folders), keywords: where.keywords, receivedAt: new Date(msg.internalDate).toISOString() } })
    } finally {
      release()
    }
    // A failed import surfaces from the final flush.
    flush(false).catch(() => {})
  }

  try {
    // Suspects first, alone in the budget and counted one at a time.
    for (const id of suspects) {
      if (full) break
      await c.store.attempt('message', c.googleId, [id], 1)
      attempted.add(id)
      await copyOne(id, true, { slowDown() {}, stopping: false, stop() {} })
      await flush(true)
    }
    let index = 0
    await runPool(rest, { max: FETCH_CONCURRENCY, min: 2 }, async (id, ctl) => {
      if (full || broken) return ctl.stop()
      const i = index++
      if (i >= counted) await count(rest, i, ATTEMPT_WINDOW)
      await copyOne(id, false, ctl)
    })
    await flush(true)
    await flushSkipped()
  } finally {
    // Stopping normally (an error included): what this job started but didn't finish wasn't to blame.
    await writes.catch(() => {})
    const unfinished = [...attempted].filter((id) => !finished.has(id))
    if (unfinished.length) await c.store.attempt('message', c.googleId, unfinished, -1)
  }

  if (full) {
    // Let go of what this job claimed but didn't copy, so the copy picks them up once there's room.
    await c.store.release('message', c.googleId, ids.filter((id) => !finished.has(id)), claim)
  }
  return { copied, skipped: skippedCount, bytes, full }
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
  /** Messages a second over the page just done, smoothed into mail_rate for the time-left estimate. */
  rate: number | null,
) {
  const counts = await store.counts('message', u.google_id)
  await env.DB.prepare(
    `UPDATE migration_users SET mail_done = ?, mail_skipped = ?, mail_total = MAX(COALESCE(?, 0), ?), mail_cursor = ?,
       mail_rate = CASE WHEN ?6 IS NULL THEN mail_rate WHEN mail_rate IS NULL THEN ?6 ELSE mail_rate * 0.6 + ?6 * 0.4 END,
       mail_note = NULL, mail_updated_at = ? WHERE migration_id = ? AND google_id = ?`,
  )
    .bind(counts.copied, counts.skipped, total, counts.copied + counts.skipped, cursor, rate, new Date().toISOString(), u.migration_id, u.google_id)
    .run()
}

export async function setIssue(env: Env, u: MigrationUserRow, issue: 'quota' | 'suspended' | 'error', message: string) {
  await env.DB.prepare(
    "UPDATE migration_users SET mail_state = 'attention', mail_issue = ?, mail_note = ?, mail_updated_at = ? WHERE migration_id = ? AND google_id = ?",
  )
    .bind(issue, message, new Date().toISOString(), u.migration_id, u.google_id)
    .run()
  // Stopped for good: a final pass waiting on this copy mustn't wait forever.
  await endFinalMail(env, u)
}

