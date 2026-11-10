// Background work for migrations, on the xstate-migration queue:
//   discover  reads the directory (users, groups, domains, shared drives) and sizes, then queues a count per user
//   count     counts one user's messages, contacts and files, acting as them; the last one marks discovery done
//   apply     creates members, mailboxes, aliases and shared mailboxes from the plan, a few users per job, then
//             starts copying
//   mail      copies one page of one person's Gmail (./mail.ts) and queues the next
//   contacts  copies one page of one person's contacts into the audience (./contacts.ts) and queues the next
//   calendar  copies one page of one person's Google Calendar events into their mailbox calendar (./calendar.ts)
//   drive     copies a person's My Drive or a shared drive into Storage, folders then a page of files (./drive.ts)
//   final_*   the final pass after the switch: Gmail history, Drive and Calendar changes since the copy (./final.ts)
// Each job is safe to run twice: rows are upserted, apply skips users and groups it already handled, and the
// MigrationStore's claims keep a message, contact or file from being copied twice.

import type { Actor } from '../auth/types'
import * as addressesDb from '../db/addresses'
import * as domainsDb from '../db/domains'
import * as membersDb from '../db/members'
import * as migrationsDb from '../db/migrations'
import { copyPendingSql as PENDING_SQL, type MigrationRow, type MigrationUserRow } from '../db/migrations'
import * as usersDb from '../db/users'
import { ApiError } from '../errors'
import { addAlias, createMailbox, grantMailboxAccess } from '../mailserver'
import { inviteMember } from '../members/service'
import { GoogleError } from './google/auth'
import { workspace } from './google/workspace'
import { calendarFinalPage, copyCalendarPage, type CalendarFinalJob, type CalendarJob } from './calendar'
import { copyContactsPage, type ContactsJob } from './contacts'
import { copyDrivePage, driveFinalPage, type DriveFinalJob, type DriveJob } from './drive'
import { finishIfDone, mailFinalPage, type MailFinalJob } from './final'
import { copyMailPage, type MailJob } from './mail'
import { existingAddresses, type StoredDomain, type StoredDrive, type StoredGroup } from './service'
import { notifyIfCopied } from './watchdog'

export type MigrationJob =
  | { kind: 'discover'; migrationId: string }
  | { kind: 'count'; migrationId: string; googleId: string }
  | { kind: 'apply'; migrationId: string }
  | MailJob
  | ContactsJob
  | CalendarJob
  | CalendarFinalJob
  | DriveJob
  | DriveFinalJob
  | MailFinalJob

/** Users handled per apply job: each is a few Stalwart calls. */
const APPLY_BATCH = 5
/** Small groups (likely shared inboxes) start ticked in the plan; bigger ones are usually mailing lists. */
export const GROUP_DEFAULT_MAX_MEMBERS = 12

export async function enqueueMigrationJobs(env: Pick<Env, 'MIGRATION'>, jobs: MigrationJob[], delaySeconds?: number): Promise<void> {
  for (let i = 0; i < jobs.length; i += 100) {
    await env.MIGRATION.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body, ...(delaySeconds && { delaySeconds }) })))
  }
}

/** How long a page waits when some of its items are held by another job's claim (one that may have died). */
export const HELD_RETRY_SECONDS = 120

export async function consumeMigration(batch: MessageBatch<MigrationJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body
    const began = Date.now()
    try {
      if (job.kind === 'discover') await discover(env, job.migrationId)
      else if (job.kind === 'count') await count(env, job.migrationId, job.googleId)
      else if (job.kind === 'mail') await copyMailPage(env, job)
      else if (job.kind === 'contacts') await copyContactsPage(env, job)
      else if (job.kind === 'calendar') await copyCalendarPage(env, job)
      else if (job.kind === 'final_calendar') await calendarFinalPage(env, job)
      else if (job.kind === 'drive') await copyDrivePage(env, job)
      else if (job.kind === 'final_drive') await driveFinalPage(env, job)
      else if (job.kind === 'final_mail') await mailFinalPage(env, job)
      else await apply(env, job.migrationId)
      message.ack()
      // How long each kind of page takes, to tune max_concurrency (wrangler.jsonc) against real imports.
      console.log(JSON.stringify({ event: 'migration_job', kind: job.kind, migrationId: job.migrationId, ms: Date.now() - began, attempt: message.attempts }))
    } catch (err) {
      console.error(`migration ${job.kind} ${job.migrationId} failed`, err)
      const last = message.attempts >= 5
      if (last || isPermanent(err)) {
        await fail(env, job, describe(err)).catch((e) => console.error('migration: recording failure failed', e))
        message.ack()
      } else {
        message.retry({ delaySeconds: 20 * message.attempts })
      }
    }
    // The last page of the last part: tell the admin the copy is ready to switch.
    if (job.kind === 'mail' || job.kind === 'contacts' || job.kind === 'drive' || job.kind === 'calendar') {
      await notifyIfCopied(env, job.migrationId).catch((err) => console.error(`migration ${job.migrationId}: ready email failed`, err))
    }
  }
}

/**
 * Jobs that used up their retries without our code seeing an error: the Worker was killed (out of memory or CPU)
 * each time. Marked as needing attention like any job that keeps failing, unless a newer chain has taken over the
 * part since (a resume or the watchdog), in which case it's left to that chain.
 */
export async function consumeMigrationDead(batch: MessageBatch<MigrationJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body
    try {
      if (await superseded(env, job)) {
        message.ack()
        continue
      }
      console.error(`migration ${job.kind} ${job.migrationId}: dead-lettered after ${message.attempts} attempts`)
      await fail(env, job, 'This part kept stopping before it could finish (the copy ran out of memory or time). Try again, or skip it.')
      message.ack()
    } catch (err) {
      console.error(`migration ${job.kind} ${job.migrationId}: recording a dead job failed`, err)
      message.retry({ delaySeconds: 60 })
    }
  }
}

/** Whether a newer chain now copies the part this job was for. */
async function superseded(env: Env, job: MigrationJob): Promise<boolean> {
  if (job.kind !== 'mail' && job.kind !== 'contacts' && job.kind !== 'calendar' && job.kind !== 'drive') return false
  if (job.kind === 'drive' && job.shared) {
    const d = await env.DB.prepare('SELECT chain FROM migration_drives WHERE migration_id = ? AND drive_id = ?').bind(job.migrationId, job.owner).first<{ chain: number }>()
    return !d || d.chain !== job.chain
  }
  const googleId = job.kind === 'drive' ? job.owner : job.googleId
  const u = await migrationsDb.findUser(env.DB, job.migrationId, googleId)
  if (!u) return true
  const current = job.kind === 'mail' ? u.mail_chain : job.kind === 'contacts' ? u.contacts_chain : job.kind === 'calendar' ? u.calendar_chain : u.drive_chain
  return current !== job.chain
}

const isPermanent = (err: unknown) =>
  (err instanceof GoogleError && ['not_configured', 'not_authorized', 'no_such_user', 'forbidden'].includes(err.code)) ||
  (err instanceof ApiError && err.status < 500)

function describe(err: unknown): string {
  if (err instanceof GoogleError && err.code === 'forbidden') return "Google refused to list the directory. Is the admin you verified with a super admin?"
  if (err instanceof GoogleError && err.code === 'not_authorized') return 'Google no longer accepts xstate’s access. Check Domain-wide delegation, then verify again.'
  return err instanceof Error ? err.message : String(err)
}

async function fail(env: Env, job: MigrationJob, error: string) {
  if (job.kind === 'discover') await migrationsDb.update(env.DB, job.migrationId, { discovery_state: 'failed', discovery_error: error }).run()
  else if (job.kind === 'count') {
    await migrationsDb.setCounts(env.DB, job.migrationId, job.googleId, { messages: null, contacts: null, files: null, error }).run()
    await finishDiscoveryIfCounted(env, job.migrationId)
  } else if (job.kind === 'final_calendar') {
    await env.DB.prepare("UPDATE migration_users SET final_calendar = 'done', calendar_note = ? WHERE migration_id = ? AND google_id = ?")
      .bind(`Final pass failed: ${error}`.slice(0, 500), job.migrationId, job.owner)
      .run()
    await finishIfDone(env, job.migrationId)
  } else if (job.kind === 'calendar') {
    await env.DB.prepare("UPDATE migration_users SET calendar_state = 'attention', calendar_note = ? WHERE migration_id = ? AND google_id = ?")
      .bind(error.slice(0, 500), job.migrationId, job.googleId)
      .run()
  } else if (job.kind === 'final_mail' || job.kind === 'final_drive') {
    // A final pass that keeps failing is given up for that part, so the pass can finish; the report says so.
    const sql =
      job.kind === 'final_mail'
        ? "UPDATE migration_users SET final_mail = 'done', mail_note = ? WHERE migration_id = ? AND google_id = ?"
        : job.shared
          ? "UPDATE migration_drives SET final_state = 'done', note = ? WHERE migration_id = ? AND drive_id = ?"
          : "UPDATE migration_users SET final_drive = 'done', drive_note = ? WHERE migration_id = ? AND google_id = ?"
    await env.DB.prepare(sql).bind(`Final pass failed: ${error}`.slice(0, 500), job.migrationId, job.owner).run()
    await finishIfDone(env, job.migrationId)
  } else if (job.kind === 'drive') {
    const sql = job.shared
      ? "UPDATE migration_drives SET state = 'attention', note = ? WHERE migration_id = ? AND drive_id = ?"
      : "UPDATE migration_users SET drive_state = 'attention', drive_note = ? WHERE migration_id = ? AND google_id = ?"
    await env.DB.prepare(sql).bind(error.slice(0, 500), job.migrationId, job.owner).run()
  } else if (job.kind === 'contacts') {
    await env.DB.prepare("UPDATE migration_users SET contacts_state = 'attention', contacts_note = ? WHERE migration_id = ? AND google_id = ?")
      .bind(error.slice(0, 500), job.migrationId, job.googleId)
      .run()
  } else if (job.kind === 'mail') {
    await env.DB.prepare(
      "UPDATE migration_users SET mail_state = 'attention', mail_issue = 'error', mail_note = ?, mail_updated_at = ? WHERE migration_id = ? AND google_id = ?",
    )
      .bind(error.slice(0, 500), new Date().toISOString(), job.migrationId, job.googleId)
      .run()
  } else await migrationsDb.update(env.DB, job.migrationId, { apply_state: 'failed', apply_error: error }).run()
}

/**
 * Queues the next page for everyone whose mail, contacts, calendar or Drive are still to copy (after Start, and on resume), or
 * only for one person or shared drive (`only`: a Google user id, or "drive:<id>"). Only call it after bumping the
 * chains of whoever it queues for: a second job on a live chain would run alongside it for good.
 */
export async function startMailCopies(env: Pick<Env, 'DB' | 'MIGRATION'>, migrationId: string, only?: string): Promise<number> {
  const user = only && !only.startsWith('drive:') ? only : null
  const sharedDrive = only?.startsWith('drive:') ? only.slice(6) : null
  const users = only ? (user ? 'AND google_id = ?2' : 'AND 0') : ''
  const sharedDrives = only ? (sharedDrive ? 'AND drive_id = ?2' : 'AND 0') : ''
  // D1 wants exactly the parameters a query uses: the second only where a query filters on it.
  const bind = (sql: string) => (sql.includes('?2') ? env.DB.prepare(sql).bind(migrationId, user ?? sharedDrive) : env.DB.prepare(sql).bind(migrationId))
  const { results: mail } = await bind(`SELECT google_id, mail_chain FROM migration_users u WHERE migration_id = ?1 AND ${PENDING_SQL.mail} ${users}`).all<{ google_id: string; mail_chain: number }>()
  const { results: contacts } = await bind(`SELECT google_id, contacts_chain FROM migration_users u WHERE migration_id = ?1 AND ${PENDING_SQL.contacts} ${users}`).all<{ google_id: string; contacts_chain: number }>()
  const { results: drive } = await bind(`SELECT google_id, drive_chain FROM migration_users u WHERE migration_id = ?1 AND ${PENDING_SQL.drive} ${users}`).all<{ google_id: string; drive_chain: number }>()
  const { results: calendar } = await bind(`SELECT google_id, calendar_chain FROM migration_users u WHERE migration_id = ?1 AND ${PENDING_SQL.calendar} ${users}`).all<{ google_id: string; calendar_chain: number }>()
  const { results: drives } = await bind(`SELECT drive_id, chain FROM migration_drives d WHERE migration_id = ?1 AND ${PENDING_SQL.sharedDrive} ${sharedDrives}`).all<{ drive_id: string; chain: number }>()
  await enqueueMigrationJobs(env, [
    ...mail.map((r) => ({ kind: 'mail' as const, migrationId, googleId: r.google_id, chain: r.mail_chain })),
    ...contacts.map((r) => ({ kind: 'contacts' as const, migrationId, googleId: r.google_id, chain: r.contacts_chain })),
    ...calendar.map((r) => ({ kind: 'calendar' as const, migrationId, googleId: r.google_id, chain: r.calendar_chain })),
    ...drive.map((r) => ({ kind: 'drive' as const, migrationId, owner: r.google_id, shared: false, chain: r.drive_chain })),
    ...drives.map((r) => ({ kind: 'drive' as const, migrationId, owner: r.drive_id, shared: true, chain: r.chain })),
  ])
  return mail.length + contacts.length + calendar.length + drive.length + drives.length
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery

async function discover(env: Env, migrationId: string): Promise<void> {
  const m = await migrationsDb.find(env.DB, migrationId)
  if (!m || m.status !== 'active' || m.discovery_state !== 'running' || !m.admin_email) return
  const ws = workspace(env)
  const admin = m.admin_email

  const [users, domains, groups, drives, usage] = await Promise.all([
    ws.listUsers(admin),
    ws.listDomains(admin),
    ws.listGroups(admin),
    ws.listSharedDrives(admin),
    ws.usage(admin),
  ])
  const storedGroups: StoredGroup[] = []
  for (const g of groups) storedGroups.push({ ...g, memberEmails: await ws.groupMemberEmails(admin, g.id) })

  // Addresses that already have an xstate mailbox in this organization: the plan copies into those.
  const existing = await existingAddresses(env, m.organization_id, users.map((u) => u.email))

  const now = new Date().toISOString()
  const writes: D1PreparedStatement[] = users.map((u) => {
    const size = usage.get(u.email)
    const mailBytes = size?.mailBytes ?? null
    // Suspended and archived people can't be acted as, so they're never counted: their sizes are what we know.
    const plan = existing.has(u.email)
      ? { action: 'existing' as const, existingAddress: u.email, mail: true, contacts: true, drive: true, calendar: true }
      : u.suspended && (mailBytes ?? 0) < 1024 ** 3
        ? { action: 'skip' as const, existingAddress: null, mail: false, contacts: false, drive: false, calendar: false }
        : u.suspended
          // Suspended people can't be read as themselves: no contacts or calendar.
          ? { action: 'shared' as const, existingAddress: null, mail: true, contacts: false, drive: true, calendar: false }
          : { action: 'create' as const, existingAddress: null, mail: true, contacts: true, drive: true, calendar: true }
    return migrationsDb.upsertUser(env.DB, {
      migrationId,
      googleId: u.id,
      email: u.email,
      name: u.name,
      suspended: u.suspended,
      aliases: u.aliases,
      mailBytes,
      driveBytes: size?.driveBytes ?? null,
      countedAt: u.suspended ? now : null,
      countError: u.suspended ? 'Suspended in Google: only sizes are known' : null,
      plan,
      recoveryEmail: u.recovery,
    })
  })
  writes.push(migrationsDb.removeUsersExcept(env.DB, migrationId, users.map((u) => u.id)))
  const primary = domains.find((d) => d.kind === 'primary')?.name ?? admin.split('@')[1]!
  writes.push(
    migrationsDb.update(env.DB, migrationId, {
      google_domain: primary,
      groups: JSON.stringify(storedGroups),
      drives: JSON.stringify(drives satisfies StoredDrive[]),
      domains: JSON.stringify(domains satisfies StoredDomain[]),
      // Keep the admin's earlier choices on a recount; new groups and drives get the defaults.
      plan_groups: JSON.stringify({
        ...Object.fromEntries(storedGroups.map((g) => [g.id, g.members <= GROUP_DEFAULT_MAX_MEMBERS])),
        ...JSON.parse(m.plan_groups ?? '{}'),
      }),
      plan_drives: JSON.stringify({ ...Object.fromEntries(drives.map((d) => [d.id, true])), ...JSON.parse(m.plan_drives ?? '{}') }),
    }),
  )
  // A recount keeps the admin's choices, except that someone who has an xstate mailbox now (made since the last
  // count) and was still on the default "create" switches to copying into it.
  if (existing.size) {
    writes.push(
      env.DB.prepare(
        `UPDATE migration_users SET action = 'existing', existing_address = email
         WHERE migration_id = ? AND action = 'create' AND email IN (SELECT value FROM json_each(?))`,
      ).bind(migrationId, JSON.stringify([...existing])),
    )
  }
  for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50))

  const toCount = users.filter((u) => !u.suspended)
  if (toCount.length) await enqueueMigrationJobs(env, toCount.map((u) => ({ kind: 'count', migrationId, googleId: u.id })))
  else await finishDiscoveryIfCounted(env, migrationId)
}

async function count(env: Env, migrationId: string, googleId: string): Promise<void> {
  const u = await migrationsDb.findUser(env.DB, migrationId, googleId)
  if (!u) return
  const c = await workspace(env).countUser(u.email)
  await migrationsDb.setCounts(env.DB, migrationId, googleId, { messages: c.messages, contacts: c.contacts, files: c.files, error: c.error ?? null }).run()
  await finishDiscoveryIfCounted(env, migrationId)
}

async function finishDiscoveryIfCounted(env: Env, migrationId: string) {
  if ((await migrationsDb.uncounted(env.DB, migrationId)) > 0) return
  await env.DB.prepare(
    "UPDATE migrations SET discovery_state = 'done', discovered_at = ?, updated_at = ? WHERE id = ? AND discovery_state = 'running'",
  )
    .bind(new Date().toISOString(), new Date().toISOString(), migrationId)
    .run()
}

// ---------------------------------------------------------------------------------------------------------------
// Start: members, mailboxes, aliases and shared mailboxes

async function apply(env: Env, migrationId: string): Promise<void> {
  const m = await migrationsDb.find(env.DB, migrationId)
  if (!m || m.status !== 'active' || m.apply_state !== 'running') return
  if (!m.started_by) throw new ApiError('no_actor', 'The admin who started this migration no longer exists', 409)
  // Everything is created as the admin who started the migration, with their access checks.
  const actor: Actor = { userId: m.started_by }
  if (!(await membersDb.find(env.DB, m.organization_id, actor.userId))) {
    throw new ApiError('no_actor', 'The admin who started this migration is no longer in the organization', 409)
  }
  const domains = new Map((await domainsDb.listByOrganization(env.DB, m.organization_id)).map((d) => [d.name, d.id]))

  const batch = await migrationsDb.unapplied(env.DB, migrationId, APPLY_BATCH)
  for (const u of batch) {
    let result: { memberId: string | null; mailboxId: string | null; error: string | null }
    try {
      result = { ...(await applyUser(env, actor, m, u, domains)), error: null }
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      result = { memberId: null, mailboxId: null, error: err.message }
    }
    await migrationsDb.setApplied(env.DB, migrationId, u.google_id, result).run()
  }
  if (batch.length === APPLY_BATCH) return enqueueMigrationJobs(env, [{ kind: 'apply', migrationId }])

  await applyGroups(env, actor, m, domains)
  // Ticked shared drives, each copied into a team folder.
  const planDrives = JSON.parse(m.plan_drives ?? '{}') as Record<string, boolean>
  const drives = (JSON.parse(m.drives ?? '[]') as { id: string; name: string }[]).filter((d) => planDrives[d.id])
  if (drives.length) {
    await env.DB.batch(
      drives.map((d) =>
        env.DB.prepare('INSERT INTO migration_drives (migration_id, drive_id, name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(migrationId, d.id, d.name),
      ),
    )
  }
  // Only the job that flips the state starts the copies: a second apply (one the watchdog restarted while this one
  // was slow) must not queue a second chain per person.
  const flipped = await env.DB.prepare("UPDATE migrations SET apply_state = 'done', updated_at = ? WHERE id = ? AND apply_state = 'running'")
    .bind(new Date().toISOString(), migrationId)
    .run()
  if (flipped.meta.changes) await startMailCopies(env, migrationId)
}

const localPart = (email: string) => email.split('@')[0]!
const domainOf = (email: string) => email.split('@')[1]!

/** The mailbox already at this address in the organization (a retried job, or one made by hand meanwhile). */
async function mailboxAt(env: Env, organizationId: string, address: string): Promise<string | null> {
  const found = await addressesDb.findByAddress(env.DB, address)
  if (!found) return null
  if (found.organization_id !== organizationId) throw new ApiError('address_taken', `${address} is used by another xstate organization`, 409)
  return found.mailbox_id
}

async function applyUser(env: Env, actor: Actor, m: MigrationRow, u: MigrationUserRow, domains: Map<string, string>) {
  if (u.action === 'skip') return { memberId: null, mailboxId: null }

  if (u.action === 'existing') {
    const mailboxId = await mailboxAt(env, m.organization_id, u.existing_address ?? u.email)
    if (!mailboxId) throw new ApiError('mailbox_missing', `${u.existing_address} no longer exists in xstate`, 409)
    const owner = await env.DB.prepare("SELECT member_id FROM mailbox_access WHERE mailbox_id = ? AND access = 'owner'").bind(mailboxId).first<{ member_id: string }>()
    return { memberId: owner?.member_id ?? null, mailboxId }
  }

  const domainId = domains.get(domainOf(u.email))
  if (!domainId) throw new ApiError('domain_missing', `${domainOf(u.email)} isn't in xstate`, 409)

  if (u.action === 'shared') {
    const mailboxId =
      (await mailboxAt(env, m.organization_id, u.email)) ??
      (await createMailbox(env, actor, { kind: 'shared', domainId, localPart: localPart(u.email), displayName: u.name })).mailbox.id
    await addAliases(env, actor, mailboxId, json(u.aliases), domains)
    return { memberId: null, mailboxId }
  }

  // create: an invited member (the invite is sent at the end of the migration) with a personal mailbox.
  const memberId = await memberFor(env, actor, m.organization_id, u)
  const mailboxId =
    (await mailboxAt(env, m.organization_id, u.email)) ??
    // No password: they sign in to xstate with the one they set when accepting the invite.
    (await createMailbox(env, actor, { kind: 'personal', domainId, localPart: localPart(u.email), displayName: u.name, ownerMemberId: memberId })).mailbox.id
  await addAliases(env, actor, mailboxId, json(u.aliases), domains)
  return { memberId, mailboxId }
}

async function memberFor(env: Env, actor: Actor, organizationId: string, u: MigrationUserRow): Promise<string> {
  const user = await usersDb.findByEmail(env.DB, u.email)
  const existing = user && (await membersDb.findByUser(env.DB, organizationId, user.id))
  if (existing) return existing.id
  const { member } = await inviteMember(env, actor, organizationId, { email: u.email, name: u.name, role: 'member', send: false })
  return member.id
}

/** Adds each alias on a domain the organization has in xstate. Others are left for the report. */
async function addAliases(env: Env, actor: Actor, mailboxId: string, aliases: string[], domains: Map<string, string>) {
  for (const alias of aliases) {
    const domainId = domains.get(domainOf(alias))
    if (!domainId) continue
    const at = await addressesDb.findByAddress(env.DB, alias)
    if (at) continue
    await addAlias(env, actor, mailboxId, { localPart: localPart(alias), domainId }).catch((err) => {
      if (!(err instanceof ApiError)) throw err
      console.warn(`migration: alias ${alias} skipped: ${err.message}`)
    })
  }
}

/** Ticked groups become shared mailboxes, opened by the migrated members who were in them. */
async function applyGroups(env: Env, actor: Actor, m: MigrationRow, domains: Map<string, string>) {
  const planGroups = JSON.parse(m.plan_groups ?? '{}') as Record<string, boolean>
  const groups = JSON.parse(m.groups ?? '[]') as StoredGroup[]
  const users = await migrationsDb.listUsers(env.DB, m.id)
  const memberByEmail = new Map(users.filter((u) => u.member_id).map((u) => [u.email, u.member_id!]))

  for (const g of groups) {
    // Done before, or failed before (the error is kept for the report).
    if (!planGroups[g.id] || g.mailboxId || g.error) continue
    try {
      const domainId = domains.get(domainOf(g.email))
      if (!domainId) throw new ApiError('domain_missing', `${domainOf(g.email)} isn't in xstate`, 409)
      const mailboxId =
        (await mailboxAt(env, m.organization_id, g.email)) ??
        (await createMailbox(env, actor, { kind: 'shared', domainId, localPart: localPart(g.email), displayName: g.name })).mailbox.id
      for (const email of g.memberEmails) {
        const memberId = memberByEmail.get(email)
        if (memberId) await grantMailboxAccess(env, actor, mailboxId, memberId)
      }
      await addAliases(env, actor, mailboxId, g.aliases, domains)
      g.mailboxId = mailboxId
      delete g.error
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      g.error = err.message
    }
    // Saved after each group, so a retry continues where this one stopped.
    await migrationsDb.update(env.DB, m.id, { groups: JSON.stringify(groups) }).run()
  }
}

const json = (value: string): string[] => JSON.parse(value) as string[]
