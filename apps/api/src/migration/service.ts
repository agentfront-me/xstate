// Import from Google Workspace: the wizard's state and its first steps (connect, discover, plan, start). See the
// Workspace Migration Plan. Discovery and Start do their work in the background (./jobs.ts); the wizard polls
// getMigration.
//
// Owners and admins run a migration; other members can look at it. One active migration per organization.

import type { Actor } from '../auth/types'
import * as addressesDb from '../db/addresses'
import * as domainsDb from '../db/domains'
import * as migrationsDb from '../db/migrations'
import type { Action, MigrationRow, MigrationUserRow } from '../db/migrations'
import { ApiError } from '../errors'
import { isAdmin, loadMember } from '../mailserver/access'
import type { EmailEnv } from '../mailserver/types'
import { GoogleError } from './google/auth'
import { PERMISSIONS, SCOPES, workspace, type Permission, type WorkspaceEnv } from './google/workspace'
import { checkOwnership, ownershipRecord, updateMailbox } from '../mailserver'
import { enqueueMigrationJobs, GROUP_DEFAULT_MAX_MEMBERS, startMailCopies } from './jobs'

export type MigrationEnv = EmailEnv & WorkspaceEnv & Pick<Env, 'MIGRATION'>

export const STAGES = ['connect', 'discover', 'plan', 'review', 'copying', 'switch', 'final', 'finish', 'done'] as const
export type Stage = (typeof STAGES)[number]

/** Stages that need discovery to have finished first. */
const AFTER_DISCOVERY: Stage[] = ['plan', 'review']

// ---------------------------------------------------------------------------------------------------------------
// What the wizard gets (apps/app/src/migration/types.ts)

export type UserPlan = { action: Action; existing?: string; mail: boolean; contacts: boolean; drive: boolean; calendar?: boolean }
export type PlanInput = {
  users: Record<string, UserPlan>
  groups: Record<string, boolean>
  drives: Record<string, boolean>
  mailRange: MigrationRow['mail_range']
}

type StoredGroup = { id: string; email: string; name: string; members: number; memberEmails: string[]; aliases: string[]; mailboxId?: string; error?: string }
type StoredDrive = { id: string; name: string; members: number | null }
type StoredDomain = { name: string; kind: 'primary' | 'secondary' | 'alias' }

const json = <T>(value: string | null, fallback: T): T => (value ? (JSON.parse(value) as T) : fallback)


async function view(env: MigrationEnv, m: MigrationRow, previousSeen: string | null) {
  const [users, starter, orgDomains] = await Promise.all([
    migrationsDb.listUsers(env.DB, m.id),
    m.started_by ? env.DB.prepare('SELECT name, email FROM users WHERE id = ?').bind(m.started_by).first<{ name: string | null; email: string }>() : null,
    domainsDb.listByOrganization(env.DB, m.organization_id),
  ])
  const ws = workspace(env)
  const clientId = await ws.clientId().catch(() => null)
  const inXstate = new Set(orgDomains.map((d) => d.name))
  const groups = json<StoredGroup[]>(m.groups, [])
  const drives = json<StoredDrive[]>(m.drives, [])
  const domains = json<StoredDomain[]>(m.domains, [])
  const discovered = m.discovery_state === 'done'
  const counted = users.filter((u) => u.counted_at).length
  const applied = await migrationsDb.applyCounts(env.DB, m.id)
  const taken = await existingAddresses(env, m.organization_id, users.map((u) => u.email))

  return {
    id: m.id,
    stage: m.stage as Stage,
    startedBy: { name: starter?.name ?? starter?.email ?? 'An admin', email: starter?.email ?? '' },
    lastSeenAt: previousSeen ?? m.last_seen_at ?? m.created_at,
    google: { clientId, configured: !!clientId, scopes: PERMISSIONS.map((id) => ({ id, scopes: SCOPES[id] })) },
    connection: m.admin_email && m.checks ? { adminEmail: m.admin_email, checks: JSON.parse(m.checks) as Record<Permission, boolean>, verifiedAt: m.verified_at } : null,
    discoveryStatus: {
      state: m.discovery_state,
      error: m.discovery_error,
      // The wizard's loading list has six parts: the directory pass covers the first five, counting the sixth.
      partsDone: m.discovery_state === 'done' ? 6 : m.google_domain ? 5 : 0,
      counted,
      total: users.length,
    },
    discovery: discovered
      ? {
          domain: m.google_domain!,
          users: users.map((u) => toGoogleUser(u, taken)),
          groups: groups.map((g) => ({
            id: g.id,
            email: g.email,
            members: g.members,
            ...(g.members > GROUP_DEFAULT_MAX_MEMBERS && { note: 'Large group, often a mailing list' }),
          })),
          drives: drives.map((d) => ({ id: d.id, name: d.name, members: d.members, bytes: null, files: null })),
          domains: domains.map((d) => ({ ...d, inXstate: inXstate.has(d.name) })),
          aliases: users.reduce((n, u) => n + json<string[]>(u.aliases, []).length, 0) + groups.reduce((n, g) => n + g.aliases.length, 0),
        }
      : null,
    plan: discovered
      ? {
          users: Object.fromEntries(users.map((u) => [u.google_id, toUserPlan(u)])),
          groups: json<Record<string, boolean>>(m.plan_groups, {}),
          drives: json<Record<string, boolean>>(m.plan_drives, {}),
          mailRange: m.mail_range,
        }
      : null,
    apply: { state: m.apply_state, error: m.apply_error, done: applied.done, failed: applied.failed, total: applied.total },
    finishedAt: m.finished_at,
  }
}

export type MigrationView = Awaited<ReturnType<typeof view>>

/** Which of these addresses already have a mailbox in the organization. */
/**
 * Throws unless every address is on a domain the organization has added to xstate and proven it owns: with the
 * ownership TXT record, or with its mail records (looked up live, so adding the record and trying again works).
 * Mail doesn't have to move first: that's the switch, later. The error carries the records to add (`details`).
 */
async function requireOwnDomains(env: MigrationEnv, organizationId: string, emails: string[], why: string): Promise<void> {
  const names = [...new Set(emails.map((e) => (e.split('@')[1] ?? '').toLowerCase()).filter(Boolean))]
  const rows = new Map((await domainsDb.listByOrganization(env.DB, organizationId)).map((d) => [d.name, d]))
  const list = (xs: string[]) => `${xs.slice(0, 3).join(', ')}${xs.length > 3 ? ' and others' : ''}`

  const missing = names.filter((n) => !rows.has(n))
  if (missing.length) {
    throw new ApiError('domain_not_added', `${why}. Add ${list(missing)} in Settings → Domains first.`, 403, { domains: missing })
  }
  const unproven: domainsDb.DomainRow[] = []
  for (const n of names) if (!(await checkOwnership(env, rows.get(n)!))) unproven.push(rows.get(n)!)
  if (unproven.length) {
    const records = unproven.map((d) => ({ domain: d.name, ...ownershipRecord(d) }))
    const how = records.map((r) => `a TXT record on ${r.domain} with the value ${r.value}`).join('; ')
    throw new ApiError(
      'domain_not_owned',
      `${why}. To prove ${list(unproven.map((d) => d.name))} ${unproven.length === 1 ? 'is' : 'are'} yours, add ${how} at your DNS host, then try again. Mail keeps going to Google until you switch.`,
      403,
      { records },
    )
  }
}

export async function existingAddresses(env: Pick<Env, 'DB'>, organizationId: string, emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set()
  const { results } = await env.DB.prepare(
    'SELECT address FROM addresses WHERE organization_id = ? AND address IN (SELECT value FROM json_each(?))',
  )
    .bind(organizationId, JSON.stringify(emails))
    .all<{ address: string }>()
  return new Set(results.map((r) => r.address))
}

function toGoogleUser(u: MigrationUserRow, taken: Set<string>) {
  return {
    id: u.google_id,
    name: u.name,
    email: u.email,
    suspended: !!u.suspended,
    mailBytes: u.mail_bytes ?? 0,
    driveBytes: u.drive_bytes ?? 0,
    messages: u.messages,
    contacts: u.contacts,
    files: u.files,
    ...(u.count_error && { countNote: u.count_error }),
    ...(taken.has(u.email) && { existingMailbox: u.email }),
  }
}

function toUserPlan(u: MigrationUserRow): UserPlan {
  return {
    action: u.action,
    ...(u.existing_address && u.action === 'existing' && { existing: u.existing_address }),
    mail: !!u.copy_mail,
    contacts: !!u.copy_contacts,
    drive: !!u.copy_drive,
    calendar: !!u.copy_calendar,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Access

export async function requireMigrationAccess(env: EmailEnv, actor: Actor, organizationId: string, need: 'read' | 'admin') {
  const member = await loadMember(env, organizationId, actor.userId)
  if (need === 'admin' && !isAdmin(member)) throw new ApiError('forbidden', 'Only owners and admins can run a migration', 403)
  return member
}
const context = requireMigrationAccess

/** The active migration; for reading (`finished: true`), the latest finished one too. */
export async function requireActive(env: Pick<Env, 'DB'>, organizationId: string, finished = false): Promise<MigrationRow> {
  const m = finished ? await migrationsDb.findCurrent(env.DB, organizationId) : await migrationsDb.findActive(env.DB, organizationId)
  if (!m) throw new ApiError('migration_not_found', 'There is no migration in progress. Open the import again to start one.', 404)
  return m
}
const active = requireActive

// ---------------------------------------------------------------------------------------------------------------
// Operations

/**
 * The organization's migration. Admins opening it for the first time start one (at Connect); others get null
 * until an admin has. Records the visit, and returns the previous one as lastSeenAt ("welcome back").
 */
export async function getMigration(env: MigrationEnv, actor: Actor, organizationId: string): Promise<MigrationView | null> {
  const member = await context(env, actor, organizationId, 'read')
  let m = await migrationsDb.findCurrent(env.DB, organizationId)
  if (!m) {
    if (!isAdmin(member)) return null
    const now = new Date().toISOString()
    await migrationsDb
      .insert(env.DB, { id: crypto.randomUUID(), organizationId, startedBy: actor.userId, now })
      .run()
      .catch((err) => {
        // Two tabs opened it at once: the other insert won, which is fine.
        if (!String(err).includes('UNIQUE constraint failed')) throw err
      })
    m = (await migrationsDb.findActive(env.DB, organizationId))!
  }
  const previous = m.last_seen_at
  if (isAdmin(member)) await migrationsDb.update(env.DB, m.id, { last_seen_at: new Date().toISOString() }).run()
  return view(env, m, previous)
}

/** Done → "Import again": a fresh migration, once the last one is finished or cancelled. */
export async function startNew(env: MigrationEnv, actor: Actor, organizationId: string): Promise<MigrationView> {
  await context(env, actor, organizationId, 'admin')
  const current = await migrationsDb.findActive(env.DB, organizationId)
  if (current) return view(env, current, null)
  const now = new Date().toISOString()
  await migrationsDb.insert(env.DB, { id: crypto.randomUUID(), organizationId, startedBy: actor.userId, now }).run()
  return view(env, (await migrationsDb.findActive(env.DB, organizationId))!, null)
}

export async function setStage(env: MigrationEnv, actor: Actor, organizationId: string, stage: Stage): Promise<MigrationView> {
  await context(env, actor, organizationId, 'admin')
  const m = await active(env, organizationId)
  if (AFTER_DISCOVERY.includes(stage) && m.discovery_state !== 'done') throw new ApiError('not_discovered', 'Finish discovery first', 409)
  if (stage === 'copying' && m.apply_state === 'idle') throw new ApiError('not_started', 'Start the migration from the Review step', 409)
  if (['connect', 'discover', 'plan', 'review'].includes(stage) && m.apply_state !== 'idle') {
    throw new ApiError('already_started', 'The migration has started; the plan can no longer change', 409)
  }
  const patch: Parameters<typeof migrationsDb.update>[2] = { stage }
  if (stage === 'done') {
    // Finishing stops nothing, so it waits for the copy and the final sync (jobs that run on and a second import
    // that could never start would follow).
    if (m.apply_state !== 'done' || m.final_state !== 'done') throw new ApiError('not_finished', 'The final sync has to finish before the import can', 409)
    Object.assign(patch, { status: 'finished', finished_at: new Date().toISOString() })
  }
  await migrationsDb.update(env.DB, m.id, patch).run()
  return view(env, (await migrationsDb.find(env.DB, m.id))!, null)
}

/** Connect → Verify: asks Google for a token per permission, acting as the admin. */
export async function verify(env: MigrationEnv, actor: Actor, organizationId: string, adminEmail: string): Promise<MigrationView> {
  await context(env, actor, organizationId, 'admin')
  const m = await active(env, organizationId)
  if (m.apply_state !== 'idle') throw new ApiError('already_started', 'The migration has already started', 409)
  const email = adminEmail.trim().toLowerCase()
  let result
  try {
    result = await workspace(env).checkScopes(email)
  } catch (err) {
    if (err instanceof GoogleError && err.code === 'not_configured') throw new ApiError('google_not_configured', 'Importing from Google isn’t set up on this server yet.', 503)
    if (err instanceof GoogleError) throw new ApiError('google_error', err.message, 502)
    throw err
  }
  if (result.noUser) {
    throw new ApiError(
      'admin_not_found',
      `Google doesn't know ${email}, or it's suspended. Use the email of an active super admin in the Workspace.`,
      400,
    )
  }
  // xstate's service account is the same for every customer, so Google accepting the admin proves nothing about
  // whose Workspace it is. Owning the admin's domain in xstate (proven in DNS) does.
  await requireOwnDomains(env, organizationId, [email], 'The admin must be on a domain this organization owns in xstate')
  // A new admin or a different Workspace starts discovery over.
  const changed = m.admin_email !== email
  await migrationsDb
    .update(env.DB, m.id, {
      admin_email: email,
      checks: JSON.stringify(result.checks),
      verified_at: new Date().toISOString(),
      ...(changed && { discovery_state: 'idle', discovery_error: null, google_domain: null }),
    })
    .run()
  return view(env, (await migrationsDb.find(env.DB, m.id))!, null)
}

/** Discover: starts (or restarts) the background count. The wizard polls getMigration for progress. */
export async function startDiscovery(env: MigrationEnv, actor: Actor, organizationId: string): Promise<MigrationView> {
  await context(env, actor, organizationId, 'admin')
  const m = await active(env, organizationId)
  if (m.apply_state !== 'idle') throw new ApiError('already_started', 'The migration has already started', 409)
  const checks = m.checks ? (JSON.parse(m.checks) as Record<Permission, boolean>) : null
  if (!m.admin_email || !checks || !Object.values(checks).every(Boolean)) {
    throw new ApiError('not_connected', 'Connect Google Workspace first: every permission has to pass Verify', 409)
  }
  await migrationsDb
    .update(env.DB, m.id, { discovery_state: 'running', discovery_error: null, google_domain: null, stage: 'discover' })
    .run()
  await enqueueMigrationJobs(env, [{ kind: 'discover', migrationId: m.id }])
  return view(env, (await migrationsDb.find(env.DB, m.id))!, null)
}

export async function savePlan(env: MigrationEnv, actor: Actor, organizationId: string, plan: PlanInput): Promise<void> {
  await context(env, actor, organizationId, 'admin')
  const m = await active(env, organizationId)
  if (m.discovery_state !== 'done') throw new ApiError('not_discovered', 'Finish discovery first', 409)
  if (m.apply_state !== 'idle') throw new ApiError('already_started', 'The migration has started; the plan can no longer change', 409)

  const users = await migrationsDb.listUsers(env.DB, m.id)
  const known = new Set(users.map((u) => u.google_id))
  const writes: D1PreparedStatement[] = [
    migrationsDb.update(env.DB, m.id, {
      plan_groups: JSON.stringify(plan.groups),
      plan_drives: JSON.stringify(plan.drives),
      mail_range: plan.mailRange,
    }),
  ]
  for (const [googleId, p] of Object.entries(plan.users)) {
    if (!known.has(googleId)) continue
    if (p.action === 'existing' && !p.existing) throw new ApiError('invalid_plan', 'Pick the xstate mailbox to copy into')
    const skip = p.action === 'skip'
    writes.push(
      migrationsDb.setPlan(env.DB, m.id, googleId, {
        action: p.action,
        existingAddress: p.action === 'existing' ? p.existing!.toLowerCase() : null,
        mail: !skip && p.mail,
        // A shared mailbox has no owner whose contacts these would be.
        contacts: !skip && p.action !== 'shared' && p.contacts,
        drive: !skip && p.drive,
        // Suspended people's calendars can't be read (Google won't act as them), and a shared mailbox has no owner.
        calendar: !skip && p.action !== 'shared' && !!p.calendar,
      }),
    )
  }
  for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50))
}

/**
 * Review → Start: checks the plan can be carried out, then creates the members, mailboxes, aliases and shared
 * mailboxes in the background. Copying itself starts in phase 2.
 */
export async function start(env: MigrationEnv, actor: Actor, organizationId: string): Promise<MigrationView> {
  await context(env, actor, organizationId, 'admin')
  const m = await active(env, organizationId)
  if (m.discovery_state !== 'done') throw new ApiError('not_discovered', 'Finish discovery first', 409)
  if (m.apply_state !== 'idle') return view(env, m, null)

  const [users, orgDomains] = await Promise.all([migrationsDb.listUsers(env.DB, m.id), domainsDb.listByOrganization(env.DB, organizationId)])
  const inXstate = new Set(orgDomains.map((d) => d.name))
  const planGroups = json<Record<string, boolean>>(m.plan_groups, {})
  const groups = json<StoredGroup[]>(m.groups, []).filter((g) => planGroups[g.id])

  // Every address we'll create has to be on a domain the organization has in xstate.
  const needed = [
    ...users.filter((u) => u.action === 'create' || u.action === 'shared').map((u) => u.email),
    ...groups.map((g) => g.email),
  ]
  const missing = [...new Set(needed.map((e) => e.split('@')[1]!).filter((d) => !inXstate.has(d)))]
  if (missing.length) {
    throw new ApiError('domains_missing', `Add ${missing.join(', ')} to xstate first (Settings → Domains). Addresses on ${missing.length === 1 ? 'it' : 'them'} can't be created until then.`, 409)
  }
  // And everyone whose data is copied, whatever the plan does with it, must be on a domain this organization has
  // proven it owns: that's what shows the Workspace is theirs to copy.
  await requireOwnDomains(
    env,
    organizationId,
    users.filter((u) => u.action !== 'skip').map((u) => u.email),
    'Every person copied must be on a domain this organization owns in xstate (or skip them)',
  )
  // An address that has a mailbox already can't be created again: the admin picks "Use existing" for it.
  const taken = await existingAddresses(env, organizationId, needed)
  if (taken.size) {
    const who = users.filter((u) => taken.has(u.email) && u.action !== 'existing').map((u) => u.name)
    const list = [...taken].slice(0, 3).join(', ')
    throw new ApiError(
      'address_exists',
      `${list}${taken.size > 3 ? ' and others' : ''} already ${taken.size === 1 ? 'has' : 'have'} an xstate mailbox. ${who.length ? `Choose “Use existing” for ${who.slice(0, 3).join(', ')}, or skip ${who.length === 1 ? 'them' : 'those people'}.` : 'Untick that group, or remove the mailbox first.'}`,
      409,
    )
  }
  for (const u of users.filter((x) => x.action === 'existing')) {
    const found = u.existing_address && (await addressesDb.findByAddress(env.DB, u.existing_address))
    if (!found || found.organization_id !== organizationId) {
      throw new ApiError('mailbox_missing', `${u.existing_address ?? 'The mailbox'} for ${u.name} isn't an xstate mailbox in this organization`, 409)
    }
  }

  await migrationsDb.update(env.DB, m.id, { apply_state: 'running', apply_error: null, started_at: new Date().toISOString(), stage: 'copying' }).run()
  await enqueueMigrationJobs(env, [{ kind: 'apply', migrationId: m.id }])
  return view(env, (await migrationsDb.find(env.DB, m.id))!, null)
}

// ---------------------------------------------------------------------------------------------------------------
// 5 · Copying

type Count = { done: number; total: number }
type UserState = 'waiting' | 'copying' | 'slowed' | 'attention' | 'paused' | 'done'
/** Migration jobs the queue runs at once (max_concurrency for xstate-migration in wrangler.jsonc). */
const MIGRATION_PARALLEL = 5


export async function copyStatus(env: MigrationEnv, actor: Actor, organizationId: string) {
  await context(env, actor, organizationId, 'read')
  const m = await active(env, organizationId, true)
  const users = (await migrationsDb.listUsers(env.DB, m.id)).filter((u) => u.action !== 'skip')
  const taken = await existingAddresses(env, organizationId, users.map((u) => u.email))
  const stopped = !!(m.paused_at || m.access_lost_at)

  let processed = 0
  let total = 0
  let copied = 0
  let contactsCopied = 0
  let events = 0
  let files = 0
  let mailMeasured = 0
  const mailSeconds: number[] = []
  const rows = users.map((u) => {
    const mailTotal = Math.max(u.mail_total ?? u.messages ?? 0, u.mail_done + u.mail_skipped)
    // Planned mail, unless Start couldn't make a mailbox for them.
    const mail: Count | null = u.copy_mail && (u.mailbox_id !== null || !u.applied_at)
      ? { done: u.mail_state === 'done' ? mailTotal : u.mail_done + u.mail_skipped, total: mailTotal }
      : null
    if (mail) {
      processed += mail.done
      total += mail.total
      // Mail still to copy at this person's own recent speed, when there is one.
      if (u.mail_state === 'copying' && u.mail_rate && u.mail_rate > 0) {
        mailMeasured += mail.total - mail.done
        mailSeconds.push((mail.total - mail.done) / u.mail_rate)
      }
    }
    copied += u.mail_done
    // Contacts belong to a member, so people imported as shared mailboxes have none.
    const contacts: Count | null = u.copy_contacts && u.action !== 'shared'
      ? { done: u.contacts_state === 'done' ? (u.contacts_total ?? u.contacts_done) : u.contacts_done, total: Math.max(u.contacts_total ?? u.contacts ?? 0, u.contacts_done) }
      : null
    if (contacts) {
      processed += contacts.done
      total += contacts.total
      contactsCopied += u.contacts_state === 'done' ? (u.contacts_total ?? u.contacts_done) : u.contacts_done
    }
    // Google doesn't say how many events there are: the total is what's been handled, plus one while copying.
    const calendar: Count | null = u.copy_calendar && (u.mailbox_id !== null || !u.applied_at)
      ? { done: u.calendar_done, total: u.calendar_state === 'done' ? u.calendar_done : u.calendar_done + 1 }
      : null
    if (calendar) {
      processed += calendar.done
      total += calendar.total
      events += u.calendar_done
    }
    const drive: Count | null = u.copy_drive
      ? { done: u.drive_done, total: u.drive_state === 'done' ? u.drive_done : Math.max(u.files ?? 0, u.drive_done) }
      : null
    if (drive) {
      processed += drive.done
      total += drive.total
      files += u.drive_done
    }
    const mailState = !mail ? 'done' : u.mail_state === 'done' ? 'done' : u.mail_state === 'attention' ? 'attention' : u.mail_state === 'copying' ? (u.mail_note === 'slowed' ? 'slowed' : 'copying') : 'waiting'
    const contactsState = !contacts ? 'done' : u.contacts_state === 'done' ? 'done' : u.contacts_state === 'attention' ? 'attention' : u.contacts_state === 'copying' ? 'copying' : 'waiting'
    const driveState = !drive ? 'done' : u.drive_state === 'done' ? 'done' : u.drive_state === 'attention' ? 'attention' : u.drive_state === 'copying' ? 'copying' : 'waiting'
    const calendarState = !calendar ? 'done' : u.calendar_state === 'done' ? 'done' : u.calendar_state === 'attention' ? 'attention' : u.calendar_state === 'copying' ? 'copying' : 'waiting'
    const parts = [mailState, contactsState, driveState, calendarState]
    let state: UserState =
      !u.applied_at ? 'waiting'
      : parts.includes('attention') ? 'attention'
      : parts.every((p) => p === 'done') ? 'done'
      : parts.includes('slowed') ? 'slowed'
      : parts.includes('copying') || parts.includes('done') ? 'copying'
      : 'waiting'
    // Paused or without access, rows that were moving show it; ones needing a fix keep saying so.
    if (stopped && (state === 'copying' || state === 'slowed' || state === 'waiting')) state = 'paused'
    return {
      user: toGoogleUser(u, taken),
      action: u.action,
      mail,
      contacts,
      drive,
      calendar,
      state,
      ...(u.mail_state === 'attention' && { issue: u.mail_issue ?? 'error', issueText: u.mail_note ?? 'Something went wrong copying this mailbox.' }),
      ...(u.mail_state !== 'attention' && u.contacts_state === 'attention' && { issue: 'error', issueText: u.contacts_note ?? 'Something went wrong copying the contacts.' }),
      ...(u.mail_state !== 'attention' && u.contacts_state !== 'attention' && u.drive_state === 'attention' && { issue: 'error', issueText: u.drive_note ?? 'Something went wrong copying Drive.' }),
      ...(u.mail_state !== 'attention' && u.contacts_state !== 'attention' && u.drive_state !== 'attention' && u.calendar_state === 'attention' && {
        issue: 'error',
        issueText: u.calendar_note ?? 'Something went wrong copying the calendar.',
      }),
      ...(u.apply_error && { issue: 'error', issueText: u.apply_error, state: 'attention' as const }),
    }
  })

  // Shared drives get a row each, like a person with only a Drive column.
  for (const d of await migrationsDb.listDrives(env.DB, m.id)) {
    const count: Count = { done: d.done, total: d.state === 'done' ? d.done : Math.max(d.done, 1) }
    processed += count.done
    total += count.total
    files += d.done
    let state: UserState = d.state === 'done' ? 'done' : d.state === 'attention' ? 'attention' : d.state === 'copying' ? 'copying' : 'waiting'
    if (stopped && (state === 'copying' || state === 'waiting')) state = 'paused'
    rows.push({
      user: { id: `drive:${d.drive_id}`, name: d.name, email: 'Shared drive', suspended: false, mailBytes: 0, driveBytes: d.bytes, messages: null, contacts: null, files: null },
      action: 'shared' as const,
      mail: null,
      contacts: null,
      drive: count,
      calendar: null,
      state,
      ...(d.state === 'attention' && { issue: 'error', issueText: d.note ?? 'Something went wrong copying this shared drive.' }),
    } as (typeof rows)[number])
  }

  const doneUsers = rows.filter((r) => r.state === 'done').length
  const finished = m.apply_state === 'done' && doneUsers === rows.length
  // Time left. Mail with a measured speed: each person's mail at their own recent speed, people copied a few at a
  // time (the queue runs MIGRATION_PARALLEL jobs at once). Everything else at the rate so far, or until there is one
  // a guess of 50 items a second.
  const elapsed = m.started_at ? (Date.now() - Date.parse(m.started_at)) / 1000 : 0
  const rate = elapsed > 60 && processed ? processed / elapsed : 50
  const mailLeft = mailSeconds.length ? Math.max(...mailSeconds, mailSeconds.reduce((a, b) => a + b, 0) / MIGRATION_PARALLEL) : 0
  const otherLeft = Math.max(0, total - processed - mailMeasured) / rate
  return {
    users: rows,
    percent: finished ? 100 : total ? Math.min(99, Math.floor((processed / total) * 100)) : 0,
    doneUsers,
    remaining: Math.max(60, Math.round(Math.max(mailLeft, otherLeft))),
    paused: !!m.paused_at,
    accessLost: !!m.access_lost_at,
    ...(stopped && { pausedAt: m.access_lost_at ?? m.paused_at }),
    finished,
    totals: { messages: copied, contacts: contactsCopied, files, events },
    apply: { state: m.apply_state, error: m.apply_error },
  }
}

/** Starts a new chain of jobs for these users (or everyone copying), so jobs from before a pause stop. */
export async function restart(env: MigrationEnv, migrationId: string, googleId?: string) {
  await env.DB.prepare(
    `UPDATE migration_users SET mail_chain = mail_chain + 1, contacts_chain = contacts_chain + 1, drive_chain = drive_chain + 1, calendar_chain = calendar_chain + 1
     WHERE migration_id = ? AND (? IS NULL OR google_id = ?)`,
  )
    .bind(migrationId, googleId ?? null, googleId ?? null)
    .run()
  await env.DB.prepare('UPDATE migration_drives SET chain = chain + 1 WHERE migration_id = ? AND (? IS NULL OR drive_id = ?)')
    .bind(migrationId, googleId?.replace(/^drive:/, '') ?? null, googleId?.replace(/^drive:/, '') ?? null)
    .run()
  // Only the chains just bumped: queueing everyone would start a second chain for every other person.
  await startMailCopies(env, migrationId, googleId)
}

export async function pause(env: MigrationEnv, actor: Actor, organizationId: string): Promise<void> {
  await context(env, actor, organizationId, 'admin')
  const m = await active(env, organizationId)
  if (!m.paused_at) await migrationsDb.update(env.DB, m.id, { paused_at: new Date().toISOString() }).run()
}

export async function resume(env: MigrationEnv, actor: Actor, organizationId: string): Promise<void> {
  await context(env, actor, organizationId, 'admin')
  const m = await active(env, organizationId)
  await migrationsDb.update(env.DB, m.id, { paused_at: null }).run()
  if (!m.access_lost_at && m.apply_state === 'done') await restart(env, m.id)
}

/** Stops the migration for good. What was already copied stays in xstate. */
export async function cancel(env: MigrationEnv, actor: Actor, organizationId: string): Promise<void> {
  await context(env, actor, organizationId, 'admin')
  const m = await active(env, organizationId)
  await migrationsDb.update(env.DB, m.id, { status: 'cancelled', finished_at: new Date().toISOString() }).run()
}

/** After Google access was lost: checks it again, and carries on copying if it's back. */
export async function checkAccess(env: MigrationEnv, actor: Actor, organizationId: string): Promise<boolean> {
  await context(env, actor, organizationId, 'admin')
  const m = await active(env, organizationId)
  if (!m.admin_email) return false
  const { checks } = await workspace(env).checkScopes(m.admin_email)
  if (!Object.values(checks).every(Boolean)) return false
  await migrationsDb.update(env.DB, m.id, { access_lost_at: null, checks: JSON.stringify(checks) }).run()
  if (!m.paused_at && m.apply_state === 'done') await restart(env, m.id)
  return true
}

/**
 * Unblocks one person whose copy needs attention: 'raise' removes the quota of their xstate mailbox (it was too
 * small for their Gmail), 'retry' tries again (after restoring a suspended account in Google, say), 'skip' gives up on
 * whichever of their parts needs attention (what was copied stays; the report lists them).
 */
export async function fixUser(env: MigrationEnv, actor: Actor, organizationId: string, googleId: string, fix: 'raise' | 'retry' | 'skip'): Promise<void> {
  await context(env, actor, organizationId, 'admin')
  const m = await active(env, organizationId)
  // A shared drive's row (id "drive:<id>"): skip or try again; nothing else applies.
  if (googleId.startsWith('drive:')) {
    const driveId = googleId.slice(6)
    const sql =
      fix === 'skip'
        ? "UPDATE migration_drives SET state = 'done', note = 'Skipped by an admin' WHERE migration_id = ? AND drive_id = ? AND state = 'attention'"
        : "UPDATE migration_drives SET state = CASE WHEN cursor IS NULL AND folder_id IS NULL THEN NULL ELSE 'copying' END, note = NULL WHERE migration_id = ? AND drive_id = ? AND state = 'attention'"
    await env.DB.prepare(sql).bind(m.id, driveId).run()
    if (fix !== 'skip' && !m.paused_at && !m.access_lost_at) await restart(env, m.id, googleId)
    return
  }
  const u = await migrationsDb.findUser(env.DB, m.id, googleId)
  if (!u) throw new ApiError('user_not_found', 'No such person in this migration', 404)
  if (fix === 'skip') {
    await env.DB.prepare(
      `UPDATE migration_users SET
         mail_state = CASE WHEN mail_state = 'attention' THEN 'done' ELSE mail_state END,
         mail_note = CASE WHEN mail_state = 'attention' THEN 'Skipped by an admin' ELSE mail_note END, mail_issue = NULL,
         contacts_state = CASE WHEN contacts_state = 'attention' THEN 'done' ELSE contacts_state END,
         contacts_note = CASE WHEN contacts_state = 'attention' THEN 'Skipped by an admin' ELSE contacts_note END,
         drive_state = CASE WHEN drive_state = 'attention' THEN 'done' ELSE drive_state END,
         drive_note = CASE WHEN drive_state = 'attention' THEN 'Skipped by an admin' ELSE drive_note END,
         calendar_state = CASE WHEN calendar_state = 'attention' THEN 'done' ELSE calendar_state END,
         calendar_note = CASE WHEN calendar_state = 'attention' THEN 'Skipped by an admin' ELSE calendar_note END
       WHERE migration_id = ? AND google_id = ?`,
    )
      .bind(m.id, googleId)
      .run()
    return
  }
  if (fix === 'raise') {
    if (!u.mailbox_id) throw new ApiError('no_mailbox', 'This person has no xstate mailbox', 409)
    await updateMailbox(env, actor, u.mailbox_id, { quotaBytes: null })
  }
  await env.DB.prepare(
    `UPDATE migration_users SET
       mail_state = CASE WHEN mail_state <> 'attention' THEN mail_state WHEN history_id IS NULL THEN NULL ELSE 'copying' END,
       mail_issue = NULL, mail_note = CASE WHEN mail_state = 'attention' THEN NULL ELSE mail_note END, mail_revivals = 0,
       contacts_state = CASE WHEN contacts_state = 'attention' THEN (CASE WHEN contacts_cursor IS NULL THEN NULL ELSE 'copying' END) ELSE contacts_state END,
       contacts_note = CASE WHEN contacts_state = 'attention' THEN NULL ELSE contacts_note END,
       drive_state = CASE WHEN drive_state = 'attention' THEN (CASE WHEN drive_cursor IS NULL THEN NULL ELSE 'copying' END) ELSE drive_state END,
       drive_note = CASE WHEN drive_state = 'attention' THEN NULL ELSE drive_note END,
       calendar_state = CASE WHEN calendar_state = 'attention' THEN (CASE WHEN calendar_cursor IS NULL THEN NULL ELSE 'copying' END) ELSE calendar_state END,
       calendar_note = CASE WHEN calendar_state = 'attention' THEN NULL ELSE calendar_note END
     WHERE migration_id = ? AND google_id = ?`,
  )
    .bind(m.id, googleId)
    .run()
  if (!m.paused_at && !m.access_lost_at) await restart(env, m.id, googleId)
}

export type { StoredDomain, StoredDrive, StoredGroup }
