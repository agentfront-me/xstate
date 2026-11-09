// Upkeep of Google Workspace imports, run by the hourly cron (index.ts). See the Workspace Migration Plan, phase 6.
//
//   watchdog  restarts a part whose job chain was lost. Every hour each part still copying is fingerprinted (its
//             state, counts and cursor); one whose fingerprint hasn't changed since the hour before is stuck, because
//             a queue job never runs longer than 15 minutes (and a claim stays live for 20, store.ts). Restarting bumps its chain, so if the old chain was
//             only slow it stops, and the MigrationStore's claims mean nothing is copied twice.
//   ready     emails the admin who started the import once nothing is left to copy. Also checked after every copy
//             job (jobs.ts), so the email usually goes out within seconds; the hourly run is the backstop.
//   access    after an import ends, asks Google once a day whether xstate's access was removed. Settings reminds
//             admins until it is (accessReminder).
//   cleanup   deletes the organization's MigrationStore (which Google item became what, and the skipped items in the
//             report) 30 days after an import finished, or 90 days after one was cancelled: a cancelled import
//             started again within that time still won't copy anything twice.

import type { Actor } from '../auth/types'
import * as migrationsDb from '../db/migrations'
import { copyPending, copyPendingSql as PENDING_SQL, type MigrationDriveRow, type MigrationRow, type MigrationUserRow } from '../db/migrations'
import * as usersDb from '../db/users'
import { isAdmin, loadMember } from '../mailserver/access'
import { sendSystemEmail } from '../mailserver/system-mail'
import { refreshAccess } from './cutover'
import { enqueueMigrationJobs, type MigrationJob } from './jobs'
import { readyEmail } from './ready-email'
import { restart } from './service'
import { migrationStore } from './store'

const DAY_MS = 24 * 60 * 60 * 1000
/** How long the MigrationStore (and so the report's list of skipped items) is kept after an import ends. */
export const KEEP_AFTER_FINISH_DAYS = 30
const KEEP_AFTER_CANCEL_DAYS = 90

export async function migrationHourly(env: Env): Promise<void> {
  const parts = { watchdog, ready: readySweep, access: accessSweep, cleanup }
  await Promise.all(
    Object.entries(parts).map(([name, run]) => run(env).catch((err) => console.error(`migration hourly ${name} failed`, err))),
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Watchdog

async function watchdog(env: Env): Promise<void> {
  // Finished imports too while their second final pass runs.
  const { results } = await env.DB.prepare("SELECT * FROM migrations WHERE status = 'active' OR (status = 'finished' AND final_state = 'running')").all<MigrationRow>()
  for (const m of results) await watchOne(env, m).catch((err) => console.error(`migration ${m.id}: watchdog failed`, err))
}

async function watchOne(env: Env, m: MigrationRow): Promise<void> {
  if (m.paused_at || m.access_lost_at) {
    // Nothing moves on purpose. Start watching afresh once it carries on.
    await env.DB.batch([
      env.DB.prepare('UPDATE migrations SET watch = NULL WHERE id = ?').bind(m.id),
      env.DB.prepare('UPDATE migration_users SET watch = NULL WHERE migration_id = ? AND watch IS NOT NULL').bind(m.id),
      env.DB.prepare('UPDATE migration_drives SET watch = NULL WHERE migration_id = ? AND watch IS NOT NULL').bind(m.id),
    ])
    return
  }
  const jobs: MigrationJob[] = []
  const restarts: string[] = []
  const writes: D1PreparedStatement[] = []

  // Discovery and Start, before anything is copied.
  let watch: string | null = null
  if (m.discovery_state === 'running') {
    const counts = await env.DB.prepare('SELECT COUNT(*) AS users, COUNT(*) - COUNT(counted_at) AS uncounted FROM migration_users WHERE migration_id = ?')
      .bind(m.id)
      .first<{ users: number; uncounted: number }>()
    watch = `discover:${counts?.users ?? 0}:${counts?.uncounted ?? 0}`
    if (watch === m.watch) {
      if (!counts?.users) jobs.push({ kind: 'discover', migrationId: m.id })
      else {
        const { results } = await env.DB.prepare('SELECT google_id FROM migration_users WHERE migration_id = ? AND counted_at IS NULL').bind(m.id).all<{ google_id: string }>()
        jobs.push(...results.map((r) => ({ kind: 'count' as const, migrationId: m.id, googleId: r.google_id })))
      }
    }
  } else if (m.apply_state === 'running') {
    watch = `apply:${(await migrationsDb.applyCounts(env.DB, m.id)).done}`
    if (watch === m.watch) jobs.push({ kind: 'apply', migrationId: m.id })
  }
  if (watch !== m.watch) writes.push(env.DB.prepare('UPDATE migrations SET watch = ? WHERE id = ?').bind(watch, m.id))

  if (m.apply_state === 'done') {
    const run = m.final_runs + 1
    for (const u of await migrationsDb.listUsers(env.DB, m.id)) {
      const copying = userCopying(u)
      const final = u.final_mail === 'running' || u.final_drive === 'running' || u.final_calendar === 'running'
      const fp = copying || final ? userFingerprint(u) : null
      if (fp && fp === u.watch) {
        if (copying) restarts.push(u.google_id)
        if (u.final_mail === 'running') jobs.push({ kind: 'final_mail', migrationId: m.id, owner: u.google_id, run })
        if (u.final_drive === 'running') jobs.push({ kind: 'final_drive', migrationId: m.id, owner: u.google_id, shared: false, run })
        if (u.final_calendar === 'running') jobs.push({ kind: 'final_calendar', migrationId: m.id, owner: u.google_id, run })
      }
      if (fp !== u.watch) writes.push(env.DB.prepare('UPDATE migration_users SET watch = ? WHERE migration_id = ? AND google_id = ?').bind(fp, m.id, u.google_id))
    }
    for (const d of await migrationsDb.listDrives(env.DB, m.id)) {
      const copying = !d.state || d.state === 'copying'
      const final = d.final_state === 'running'
      const fp = copying || final ? driveFingerprint(d) : null
      if (fp && fp === d.watch) {
        if (copying) restarts.push(`drive:${d.drive_id}`)
        if (final) jobs.push({ kind: 'final_drive', migrationId: m.id, owner: d.drive_id, shared: true, run })
      }
      if (fp !== d.watch) writes.push(env.DB.prepare('UPDATE migration_drives SET watch = ? WHERE migration_id = ? AND drive_id = ?').bind(fp, m.id, d.drive_id))
    }
  }

  for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50))
  for (const id of restarts) await restart(env, m.id, id)
  if (jobs.length) await enqueueMigrationJobs(env, jobs)
  if (restarts.length || jobs.length) {
    console.warn(`migration ${m.id}: watchdog restarted ${[...restarts, ...jobs.map((j) => j.kind)].join(', ')} (no progress for an hour)`)
  }
}

/** Whether any of a person's parts still has pages to copy: the same test as startMailCopies. */
const userCopying = (u: MigrationUserRow) => copyPending.mail(u) || copyPending.contacts(u) || copyPending.drive(u) || copyPending.calendar(u)

/** Everything a page of work changes. Equal an hour apart means no page ran. */
const userFingerprint = (u: MigrationUserRow) =>
  JSON.stringify([
    u.mail_state, u.mail_done, u.mail_skipped, u.mail_cursor, u.mail_updated_at,
    u.contacts_state, u.contacts_done, u.contacts_cursor,
    u.drive_state, u.drive_done, u.drive_copied_bytes, u.drive_cursor,
    u.calendar_state, u.calendar_done, u.calendar_cursor,
    u.final_mail, u.final_mail_cursor, u.final_mail_changes, u.final_drive, u.final_drive_changes, u.drive_changes_token,
    u.final_calendar, u.final_calendar_cursor, u.final_calendar_changes,
  ])

const driveFingerprint = (d: MigrationDriveRow) => JSON.stringify([d.state, d.done, d.bytes, d.cursor, d.folder_id, d.final_state, d.final_changes, d.changes_token])

// ---------------------------------------------------------------------------------------------------------------
// Ready to switch

/** People or shared drives with pages still to copy (or not yet set up). */
const PENDING = `
  EXISTS (SELECT 1 FROM migration_users u WHERE u.migration_id = migrations.id AND (
    (u.action != 'skip' AND u.applied_at IS NULL) OR ${PENDING_SQL.mail} OR ${PENDING_SQL.contacts} OR ${PENDING_SQL.drive} OR ${PENDING_SQL.calendar}))
  OR EXISTS (SELECT 1 FROM migration_drives d WHERE d.migration_id = migrations.id AND ${PENDING_SQL.sharedDrive})`

/**
 * Emails the admin who started the import, once, when nothing is left to copy: they can switch mail over when they
 * like. People who need a fix don't hold it back; the email says how many there are. Cheap enough to call after every
 * copy job: a single UPDATE that only matches at that moment.
 */
export async function notifyIfCopied(env: Env, migrationId: string): Promise<void> {
  const now = new Date().toISOString()
  const claimed = await env.DB.prepare(
    `UPDATE migrations SET copied_notified_at = ?1 WHERE id = ?2 AND status = 'active' AND apply_state = 'done'
       AND copied_notified_at IS NULL AND final_state IS NULL AND paused_at IS NULL AND access_lost_at IS NULL
       AND NOT (${PENDING})`,
  )
    .bind(now, migrationId)
    .run()
  if (!claimed.meta.changes) return
  try {
    await sendReadyEmail(env, migrationId)
  } catch (err) {
    // Try again at the next hourly run.
    await env.DB.prepare('UPDATE migrations SET copied_notified_at = NULL WHERE id = ?').bind(migrationId).run()
    throw err
  }
}

async function readySweep(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM migrations WHERE status = 'active' AND apply_state = 'done' AND copied_notified_at IS NULL AND final_state IS NULL",
  ).all<{ id: string }>()
  for (const r of results) await notifyIfCopied(env, r.id).catch((err) => console.error(`migration ${r.id}: ready email failed`, err))
}

async function sendReadyEmail(env: Env, migrationId: string): Promise<void> {
  const m = await migrationsDb.find(env.DB, migrationId)
  const admin = m?.started_by ? await usersDb.findById(env.DB, m.started_by) : null
  if (!m || !admin) return
  const totals = await env.DB.prepare(
    `SELECT COALESCE(SUM(mail_done), 0) AS messages, COALESCE(SUM(contacts_done), 0) AS contacts, COALESCE(SUM(drive_done), 0) AS files,
       COALESCE(SUM(calendar_done), 0) AS events,
       COUNT(CASE WHEN action != 'skip' THEN 1 END) AS people,
       COUNT(CASE WHEN action != 'skip' AND (apply_error IS NOT NULL OR mail_state = 'attention' OR contacts_state = 'attention' OR drive_state = 'attention' OR calendar_state = 'attention') THEN 1 END) AS attention
     FROM migration_users WHERE migration_id = ?`,
  )
    .bind(m.id)
    .first<{ messages: number; contacts: number; files: number; events: number; people: number; attention: number }>()
  const drives = await env.DB.prepare("SELECT COALESCE(SUM(done), 0) AS files, COUNT(CASE WHEN state = 'attention' THEN 1 END) AS attention FROM migration_drives WHERE migration_id = ?")
    .bind(m.id)
    .first<{ files: number; attention: number }>()
  const org = await env.DB.prepare('SELECT name FROM organizations WHERE id = ?').bind(m.organization_id).first<{ name: string }>()

  const email = readyEmail({
    url: `${env.APP_URL.replace(/\/+$/, '')}/migrate/`,
    organization: org?.name ?? 'your organization',
    domain: m.google_domain,
    adminName: admin.name,
    people: totals?.people ?? 0,
    messages: totals?.messages ?? 0,
    contacts: totals?.contacts ?? 0,
    events: totals?.events ?? 0,
    files: (totals?.files ?? 0) + (drives?.files ?? 0),
    attention: (totals?.attention ?? 0) + (drives?.attention ?? 0),
  })
  const result = await sendSystemEmail(env, { to: { name: admin.name, email: admin.email }, ...email })
  if (!result.sent) console.warn(`migration ${m.id}: ready email not sent: ${result.reason}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Google access after the import

/** The organization's latest import, when it ended while xstate could (and maybe still can) read the Workspace. */
const ENDED_WITH_ACCESS = `
  status IN ('finished', 'cancelled') AND verified_at IS NOT NULL AND access_removed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM migrations n WHERE n.organization_id = migrations.organization_id AND n.created_at > migrations.created_at)`

async function accessSweep(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT * FROM migrations WHERE ${ENDED_WITH_ACCESS}`).all<MigrationRow>()
  for (const m of results) await refreshAccess(env, m, DAY_MS - 10 * 60_000).catch((err) => console.error(`migration ${m.id}: access check failed`, err))
}

/**
 * For Settings: whether an import that ended left xstate able to read the organization's Google Workspace. Asked
 * again at most every 10 minutes. Only admins see it (they're the ones who can remove it).
 */
export async function accessReminder(env: Env, actor: Actor, organizationId: string) {
  const member = await loadMember(env, organizationId, actor.userId)
  const m = isAdmin(member)
    ? await env.DB.prepare(`SELECT * FROM migrations WHERE organization_id = ? AND ${ENDED_WITH_ACCESS}`).bind(organizationId).first<MigrationRow>()
    : null
  if (!m) return { open: false as const }
  const { removedAt } = await refreshAccess(env, m, 10 * 60_000)
  if (removedAt) return { open: false as const }
  return { open: true as const, ended: m.status as 'finished' | 'cancelled', endedAt: m.finished_at, domain: m.google_domain }
}

// ---------------------------------------------------------------------------------------------------------------
// Cleanup

async function cleanup(env: Env): Promise<void> {
  const now = Date.now()
  const { results } = await env.DB.prepare(
    `SELECT * FROM migrations WHERE store_cleared_at IS NULL AND (final_state IS NULL OR final_state = 'done')
       AND ((status = 'finished' AND finished_at <= ?1) OR (status = 'cancelled' AND finished_at <= ?2))
       AND NOT EXISTS (SELECT 1 FROM migrations n WHERE n.organization_id = migrations.organization_id AND n.created_at > migrations.created_at)`,
  )
    .bind(new Date(now - KEEP_AFTER_FINISH_DAYS * DAY_MS).toISOString(), new Date(now - KEEP_AFTER_CANCEL_DAYS * DAY_MS).toISOString())
    .all<MigrationRow>()
  for (const m of results) {
    // An import cancelled before Start never wrote to the store.
    if (m.apply_state !== 'idle') await migrationStore(env, m.organization_id).wipe()
    await migrationsDb.update(env.DB, m.id, { store_cleared_at: new Date().toISOString() }).run()
    console.log(`migration ${m.id}: store deleted (${m.status} ${m.finished_at})`)
  }
}

/** When the report's list of skipped items is deleted, for a finished import. */
export const reportKeptUntil = (m: MigrationRow) =>
  m.status === 'finished' && m.finished_at ? new Date(Date.parse(m.finished_at) + KEEP_AFTER_FINISH_DAYS * DAY_MS).toISOString() : null
