// The final pass, after the switch: copies what changed in Google since the copy. It runs when the admin starts it
// on the Switch step, and once more 24 hours later (the hourly cron) to catch mail Google received while DNS caught
// up. See the Workspace Migration Plan, phase 5.
//
//   mail      Gmail history since the copy began: new messages are imported, label changes re-file messages,
//             deleted ones move to Trash (never deleted outright). If Google's history no longer reaches back, the
//             mailbox is listed again instead; nothing already copied is copied twice.
//   contacts  their contacts are read again; only new ones are added.
//   drive     the Drive change feed (in drive.ts): new files copied, edited files get a new version.

import * as mailboxesDb from '../db/mailboxes'
import * as migrationsDb from '../db/migrations'
import type { MigrationRow } from '../db/migrations'
import { enqueue as enqueueMailSync } from '../jobs/mail-sync'
import * as jmap from '../mailserver/stalwart/mail'
import { GoogleError } from './google/auth'
import { workspace } from './google/workspace'
import { enqueueMigrationJobs } from './jobs'
import { folderIdsFor, folders, importIds, mailLimits } from './mail'
import { placement } from './mail-rules'
import { migrationStore } from './store'

export type MailFinalJob = { kind: 'final_mail'; migrationId: string; owner: string; run: number }

/** When the automatic second pass runs after the first. */
const RERUN_AFTER_MS = 24 * 60 * 60 * 1000

/** Starts a final pass (the first from the Switch step, the second from the hourly cron). */
export async function startFinalPass(env: Env, m: MigrationRow): Promise<void> {
  const run = m.final_runs + 1
  const now = new Date()
  await migrationsDb
    .update(env.DB, m.id, {
      final_state: 'running',
      final_started_at: now.toISOString(),
      ...(run === 1 && { final_rerun_at: new Date(now.getTime() + RERUN_AFTER_MS).toISOString() }),
    })
    .run()
  const users = await migrationsDb.listUsers(env.DB, m.id)
  const jobs: Parameters<typeof enqueueMigrationJobs>[1] = []

  for (const u of users) {
    if (u.action === 'skip') continue
    const where = [m.id, u.google_id] as const
    if (u.copy_mail && u.mailbox_id && u.history_id && u.mail_state === 'done') {
      await env.DB.prepare("UPDATE migration_users SET final_mail = 'running', final_mail_changes = 0, final_mail_cursor = NULL WHERE migration_id = ? AND google_id = ?").bind(...where).run()
      jobs.push({ kind: 'final_mail', migrationId: m.id, owner: u.google_id, run })
    }
    if (u.copy_contacts && u.member_id && u.contacts_state === 'done') {
      // Read their contacts again from the start: the claims skip every one already copied.
      await env.DB.prepare(
        "UPDATE migration_users SET final_contacts_base = contacts_done, contacts_state = 'copying', contacts_cursor = NULL, contacts_chain = contacts_chain + 1 WHERE migration_id = ? AND google_id = ?",
      )
        .bind(...where)
        .run()
      jobs.push({ kind: 'contacts', migrationId: m.id, googleId: u.google_id, chain: u.contacts_chain + 1 })
    }
    if (u.copy_drive && u.drive_state === 'done') {
      await env.DB.prepare("UPDATE migration_users SET final_drive = 'running', final_drive_changes = 0 WHERE migration_id = ? AND google_id = ?").bind(...where).run()
      jobs.push({ kind: 'final_drive', migrationId: m.id, owner: u.google_id, shared: false, run })
    }
  }
  for (const d of await migrationsDb.listDrives(env.DB, m.id)) {
    if (d.state !== 'done') continue
    await env.DB.prepare("UPDATE migration_drives SET final_state = 'running', final_changes = 0 WHERE migration_id = ? AND drive_id = ?").bind(m.id, d.drive_id).run()
    jobs.push({ kind: 'final_drive', migrationId: m.id, owner: d.drive_id, shared: true, run })
  }
  await enqueueMigrationJobs(env, jobs)
  await finishIfDone(env, m.id)
}

/** Marks the pass done once every part of every person and drive is. */
export async function finishIfDone(env: Env, migrationId: string): Promise<void> {
  const busy = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM migration_users WHERE migration_id = ?1
          AND (final_mail = 'running' OR final_drive = 'running' OR (final_contacts_base IS NOT NULL AND contacts_state = 'copying'))) +
       (SELECT COUNT(*) FROM migration_drives WHERE migration_id = ?1 AND final_state = 'running') AS n`,
  )
    .bind(migrationId)
    .first<{ n: number }>()
  if (busy?.n) return
  await env.DB.prepare("UPDATE migrations SET final_state = 'done', final_runs = final_runs + 1, updated_at = ? WHERE id = ? AND final_state = 'running'")
    .bind(new Date().toISOString(), migrationId)
    .run()
}

/** Hourly: the automatic second pass, 24 hours after the first. */
export async function finalHourly(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    // Finished migrations too: admins often finish on the day, before the second pass is due.
    "SELECT * FROM migrations WHERE status IN ('active', 'finished') AND final_state = 'done' AND final_runs = 1 AND final_rerun_at <= ?",
  )
    .bind(new Date().toISOString())
    .all<MigrationRow>()
  for (const m of results) await startFinalPass(env, m).catch((err) => console.error(`migration ${m.id}: second final pass failed to start`, err))
}

// ---------------------------------------------------------------------------------------------------------------
// Mail

export async function mailFinalPage(env: Env, job: MailFinalJob): Promise<void> {
  const m = await migrationsDb.find(env.DB, job.migrationId)
  if (!m || m.status === 'cancelled' || m.paused_at || m.access_lost_at) return
  const u = await migrationsDb.findUser(env.DB, m.id, job.owner)
  if (!u || u.final_mail !== 'running' || !u.history_id || !u.mailbox_id) return
  const mailbox = await mailboxesDb.find(env.DB, u.mailbox_id)
  const where = [m.id, u.google_id] as const
  const done = async (changes: number, historyId?: string) => {
    await env.DB.prepare(
      `UPDATE migration_users SET final_mail = 'done', final_mail_changes = final_mail_changes + ?, final_mail_cursor = NULL,
         history_id = COALESCE(?, history_id) WHERE migration_id = ? AND google_id = ?`,
    )
      .bind(changes, historyId ?? null, ...where)
      .run()
    await finishIfDone(env, m.id)
  }
  if (!mailbox) return done(0)

  const ws = workspace(env)
  let history
  try {
    history = await ws.gmailHistory(u.email, u.history_id, u.final_mail_cursor)
  } catch (err) {
    if (err instanceof GoogleError && err.code === 'no_such_user') return done(0)
    throw err
  }
  if (!history) {
    // Google's history doesn't reach back that far: list the mailbox again (only new messages get copied).
    await env.DB.prepare(
      "UPDATE migration_users SET mail_state = 'copying', mail_cursor = NULL, mail_chain = mail_chain + 1 WHERE migration_id = ? AND google_id = ?",
    )
      .bind(...where)
      .run()
    await enqueueMigrationJobs(env, [{ kind: 'mail', migrationId: m.id, googleId: u.google_id, chain: u.mail_chain + 1 }])
    return done(0)
  }

  const accountId = mailbox.stalwart_id
  const store = migrationStore(env, m.organization_id)
  const place = await folders(env, m.organization_id, u.google_id, accountId, await ws.gmailLabels(u.email))
  let changes = 0

  // New messages.
  const claim = `final:${job.run}:${u.google_id}:${u.final_mail_cursor ?? 'first'}`
  const { mine } = await store.claim('message', u.google_id, history.added, claim)
  changes += (await importIds(env, { store, email: u.email, googleId: u.google_id, accountId, place, max: (await mailLimits(env)).maxSizeUpload }, mine, claim)).copied

  // Labels changed: re-file the copy and set its read and starred state.
  const labelled = await store.targets('message', u.google_id, history.labelled.map((l) => l.id))
  const userLabels = new Set(place.labels.keys())
  for (const l of history.labelled) {
    const target = labelled[l.id]
    const where = placement(l.labelIds, userLabels)
    if (!target || 'skip' in where) continue
    if (await jmap.setEmailPlacement(env, accountId, target, folderIdsFor(place, where.folders), where.keywords)) changes++
  }

  // Deleted in Gmail: to Trash in xstate, where it can still be found.
  const deleted = await store.targets('message', u.google_id, history.deleted)
  const trash = place.roles.get('trash')
  for (const target of Object.values(deleted)) {
    if (!trash) break
    await jmap.updateEmail(env, accountId, target, { folderId: trash }).catch(() => null)
    changes++
  }

  if (history.added.length) {
    await enqueueMailSync(env, [{ mailboxId: mailbox.id, reason: 'import' }])
    // Keep the per-person counts (and so the report) in step with what the pass added.
    const counts = await store.counts('message', u.google_id)
    await env.DB.prepare('UPDATE migration_users SET mail_done = ?, mail_skipped = ? WHERE migration_id = ? AND google_id = ?')
      .bind(counts.copied, counts.skipped, ...where)
      .run()
  }
  if (history.nextPageToken) {
    await env.DB.prepare('UPDATE migration_users SET final_mail_changes = final_mail_changes + ?, final_mail_cursor = ? WHERE migration_id = ? AND google_id = ?')
      .bind(changes, history.nextPageToken, ...where)
      .run()
    await enqueueMigrationJobs(env, [job])
  } else {
    await done(changes, history.historyId)
  }
}
