// Steps 6–8 of the import: switching mail over (DNS), the final pass, and finishing (removing xstate's Google
// access, sending invites, the report). See the Workspace Migration Plan, phase 5 and the cutover runbook.

import type { Actor } from '../auth/types'
import * as domainsDb from '../db/domains'
import * as migrationsDb from '../db/migrations'
import type { MigrationRow } from '../db/migrations'
import { ApiError } from '../errors'
import { domainConnectUrl, verifyDomain } from '../mailserver'
import { isAdmin } from '../mailserver/access'
import { migrationInvite } from '../members/service'
import { startFinalPass } from './final'
import { workspace } from './google/workspace'
import { requireActive, requireMigrationAccess } from './service'
import { migrationStore } from './store'
import { KEEP_AFTER_FINISH_DAYS, reportKeptUntil } from './watchdog'

type Env2 = Env

/** The active migration, for an admin. */
async function active(env: Env2, actor: Actor, organizationId: string, need: 'read' | 'admin'): Promise<MigrationRow> {
  await requireMigrationAccess(env, actor, organizationId, need)
  return requireActive(env, organizationId)
}

/** The active migration, or the latest finished one (its Done screen and report stay readable), and who's asking. */
async function current(env: Env2, actor: Actor, organizationId: string, adminOnly = false) {
  const member = await requireMigrationAccess(env, actor, organizationId, adminOnly ? 'admin' : 'read')
  return { m: await requireActive(env, organizationId, true), admin: isAdmin(member) }
}

// ---------------------------------------------------------------------------------------------------------------
// 6 · Switch

/**
 * The records each of the Workspace's domains in xstate needs, checked live in public DNS (the same check as adding
 * a domain). `detected` once every required record of every domain is found; the first time, that's remembered.
 */
export async function switchStatus(env: Env2, actor: Actor, organizationId: string) {
  const m = await active(env, actor, organizationId, 'read')
  const workspaceDomains = new Set([
    ...(JSON.parse(m.domains ?? '[]') as { name: string }[]).map((d) => d.name),
    ...(m.google_domain ? [m.google_domain] : []),
  ])
  const ours = (await domainsDb.listByOrganization(env.DB, organizationId)).filter((d) => workspaceDomains.has(d.name))
  // The primary domain first; other domains' record names are written out in full.
  ours.sort((a, b) => Number(b.name === m.google_domain) - Number(a.name === m.google_domain))

  const records: { type: string; name: string; value: string; found: boolean; required: boolean; domain: string }[] = []
  for (const d of ours) {
    const { records: rs } = await verifyDomain(env, actor, d.id)
    const qualify = (name: string) => (d.name === m.google_domain ? name : name === '@' ? d.name : `${name}.${d.name}`)
    // The switch is about mail; the ownership record was for starting the import.
    for (const r of rs.filter((x) => x.purpose !== 'Ownership')) records.push({ type: r.type, name: qualify(r.name), value: r.value, found: r.found, required: r.required, domain: d.name })
  }
  const detected = records.length > 0 && records.every((r) => r.found || !r.required)
  let detectedAt = m.switch_detected_at
  if (detected && !detectedAt) {
    detectedAt = new Date().toISOString()
    await migrationsDb.update(env.DB, m.id, { switch_detected_at: detectedAt }).run()
  }
  const primary = ours[0]
  const connect = primary && !detected ? await domainConnectUrl(env, actor, primary.id).catch(() => ({ applyUrl: null, provider: null })) : null
  return {
    ttlDone: !!m.switch_ttl_done,
    records,
    detected,
    ...(detectedAt && { detectedAt }),
    provider: connect?.provider ?? null,
    applyUrl: connect?.applyUrl ?? null,
  }
}

export async function markTtlDone(env: Env2, actor: Actor, organizationId: string) {
  const m = await active(env, actor, organizationId, 'admin')
  await migrationsDb.update(env.DB, m.id, { switch_ttl_done: 1 }).run()
  return switchStatus(env, actor, organizationId)
}

// ---------------------------------------------------------------------------------------------------------------
// 7 · Final sync

export async function startFinal(env: Env2, actor: Actor, organizationId: string): Promise<void> {
  const m = await active(env, actor, organizationId, 'admin')
  if (!m.switch_detected_at) throw new ApiError('not_switched', 'Publish xstate’s records first: the final sync runs after mail points here', 409)
  if (m.final_state === 'running') return
  await migrationsDb.update(env.DB, m.id, { stage: 'final' }).run()
  if (m.final_runs === 0) await startFinalPass(env, m)
}

export async function finalStatus(env: Env2, actor: Actor, organizationId: string) {
  const m = await active(env, actor, organizationId, 'read')
  const users = (await migrationsDb.listUsers(env.DB, m.id)).filter((u) => u.action !== 'skip')
  const drives = await migrationsDb.listDrives(env.DB, m.id)
  const running = m.final_state === 'running'
  const part = (inPass: boolean[], busy: boolean[], changes: number) => ({
    done: changes,
    total: changes,
    running: running && busy.some(Boolean),
    people: { done: inPass.length - busy.filter(Boolean).length, total: inPass.length },
  })
  const mailUsers = users.filter((u) => u.final_mail !== null)
  const contactUsers = users.filter((u) => u.final_contacts_base !== null)
  const driveUsers = users.filter((u) => u.final_drive !== null)
  const calendarUsers = users.filter((u) => u.final_calendar !== null)
  const finalDrives = drives.filter((d) => d.final_state !== null)
  return {
    mail: part(mailUsers.map(() => true), mailUsers.map((u) => u.final_mail === 'running'), mailUsers.reduce((n, u) => n + u.final_mail_changes, 0)),
    contacts: part(
      contactUsers.map(() => true),
      contactUsers.map((u) => u.contacts_state === 'copying'),
      contactUsers.reduce((n, u) => n + Math.max(0, u.contacts_done - (u.final_contacts_base ?? u.contacts_done)), 0),
    ),
    calendar: part(
      calendarUsers.map(() => true),
      calendarUsers.map((u) => u.final_calendar === 'running'),
      calendarUsers.reduce((n, u) => n + u.final_calendar_changes, 0),
    ),
    drive: part(
      [...driveUsers, ...finalDrives].map(() => true),
      [...driveUsers.map((u) => u.final_drive === 'running'), ...finalDrives.map((d) => d.final_state === 'running')],
      driveUsers.reduce((n, u) => n + u.final_drive_changes, 0) + finalDrives.reduce((n, d) => n + d.final_changes, 0),
    ),
    finished: m.final_state === 'done',
    runs: m.final_runs,
    rerunAt: m.final_rerun_at ?? new Date(Date.now() + 86_400_000).toISOString(),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 8 · Finish

/** How often Finish asks Google whether xstate's access is gone. */
const ACCESS_CHECK_MS = 60_000

/** Report labels for the reasons items were skipped. */
const REASONS: Record<string, { label: string; reason: string }> = {
  chat: { label: 'Chat messages in mail', reason: 'Google Chat isn’t imported' },
  too_large: { label: 'Messages too large for the mail server', reason: 'over the mail server’s size limit' },
  import_failed: { label: 'Messages the mail server refused', reason: 'see the CSV for each one' },
  kept_failing: { label: 'Messages that kept stopping the import', reason: 'skipped so the rest could be copied; copy them by hand from Gmail (see the CSV)' },
  deleted: { label: 'Messages deleted in Gmail during the copy', reason: 'nothing left to copy' },
  empty: { label: 'Empty contacts', reason: 'no name, email or phone' },
  shortcut: { label: 'Drive shortcuts', reason: 'they point at files, the files themselves are copied' },
  google_form: { label: 'Google Forms', reason: 'no file format to export' },
  google_site: { label: 'Google Sites', reason: 'no file format to export' },
  google_map: { label: 'Google My Maps', reason: 'no file format to export' },
  checksum_mismatch: { label: 'Files that arrived damaged', reason: 'checksum didn’t match Google’s; copy them by hand' },
  export_failed: { label: 'Google files Google wouldn’t export', reason: 'usually over Google’s export size limit' },
  gone: { label: 'Files deleted in Google during the copy', reason: 'nothing left to copy' },
  sharing_not_recreated: { label: 'Sharing not recreated', reason: 'links for anyone and people outside the organization; files are private to their owner in xstate' },
  cancelled: { label: 'Cancelled calendar events', reason: 'cancelled in Google, nothing to copy' },
  working_location: { label: 'Working-location entries', reason: 'Google’s “working from” markers aren’t calendar events' },
  birthday: { label: 'Birthday entries', reason: 'Google makes these from contacts' },
  no_time: { label: 'Calendar events without a time', reason: 'Google gave no start or end' },
  no_series: { label: 'Changes to repeating events that weren’t copied', reason: 'their series was cancelled or refused' },
  event_refused: { label: 'Calendar events the mail server refused', reason: 'see the CSV for each one' },
  guests_trimmed: { label: 'Big meetings with guests left off', reason: 'an xstate event holds at most 20 people; the rest are listed as a count in its description' },
}
const reasonOf = (reason: string) => REASONS[reason] ?? (reason.startsWith('google_') ? { label: `Google ${reason.slice(7)} files`, reason: 'no file format to export' } : { label: reason, reason: '' })

export async function finishStatus(env: Env2, actor: Actor, organizationId: string) {
  const { m, admin } = await current(env, actor, organizationId)

  // Is xstate's access gone? Asked at most once a minute. Also after finishing: an admin may finish first and remove
  // the access later.
  const { removedAt, checkedAt } = await refreshAccess(env, m, ACCESS_CHECK_MS - 5_000)

  const users = (await migrationsDb.listUsers(env.DB, m.id)).filter((u) => u.action !== 'skip')
  const invited = await newMembers(env, m)
  const report = [
    ...users.map((u) => ({
      name: u.name,
      shared: u.action === 'shared',
      messages: u.mail_done,
      contacts: u.copy_contacts && u.action !== 'shared' ? u.contacts_done : null,
      events: u.copy_calendar ? u.calendar_done : null,
      files: u.drive_done,
    })),
    ...(await migrationsDb.listDrives(env.DB, m.id)).map((d) => ({ name: `${d.name} (shared drive)`, shared: true, messages: 0, contacts: null, events: null, files: d.done })),
  ]
  const skipped = (await migrationStore(env, organizationId).problemCounts()).map((p) => ({ count: p.count, ...reasonOf(p.reason) }))
  return {
    accessRemoved: !!removedAt,
    accessRemovedAt: removedAt,
    nextCheckAt: new Date(Date.parse(checkedAt ?? new Date().toISOString()) + ACCESS_CHECK_MS).toISOString(),
    invitesSent: !!m.invites_sent_at,
    // Where each invite goes is a personal address: admins only (they send the invites).
    newMembers: invited.map((u) => ({ name: u.name, email: u.email, ...(admin && { sendTo: u.recovery_email }) })),
    report,
    skipped,
    // The list of skipped items is deleted 30 days after finishing (./watchdog.ts); the counts stay.
    skippedKeptUntil: reportKeptUntil(m),
    skippedDeleted: !!m.store_cleared_at,
  }
}

/**
 * Asks Google whether xstate's access is gone, unless it was asked less than `minAgeMs` ago, and remembers the
 * answer. Google refuses every token once the admin deletes the Domain-wide delegation entry.
 */
export async function refreshAccess(env: Pick<Env2, 'DB'> & Parameters<typeof workspace>[0], m: MigrationRow, minAgeMs: number) {
  let { access_removed_at: removedAt, access_checked_at: checkedAt } = m
  if (!removedAt && m.admin_email && (!checkedAt || Date.now() - Date.parse(checkedAt) > minAgeMs)) {
    checkedAt = new Date().toISOString()
    const result = await workspace(env).checkScopes(m.admin_email).catch(() => null)
    if (result && (result.noUser || Object.values(result.checks).every((ok) => !ok))) removedAt = checkedAt
    await migrationsDb.update(env.DB, m.id, { access_checked_at: checkedAt, access_removed_at: removedAt }).run()
  }
  return { removedAt, checkedAt }
}

/** People the migration made members who haven't accepted yet. */
async function newMembers(env: Env2, m: MigrationRow) {
  const { results } = await env.DB.prepare(
    `SELECT u.name, u.email, u.recovery_email, u.member_id FROM migration_users u JOIN members mb ON mb.id = u.member_id
     WHERE u.migration_id = ? AND u.action = 'create' AND mb.status = 'invited' ORDER BY u.name`,
  )
    .bind(m.id)
    .all<{ name: string; email: string; recovery_email: string | null; member_id: string }>()
  return results
}

/**
 * Sends each new member their invite, to the personal address Google had for them. Returns the links of anyone it
 * couldn't email (no personal address, or sending failed), for the admin to pass on.
 */
export async function sendInvites(env: Env2, actor: Actor, organizationId: string) {
  const m = await active(env, actor, organizationId, 'admin')
  const links: { name: string; email: string; url: string }[] = []
  let sent = 0
  for (const u of await newMembers(env, m)) {
    const r = await migrationInvite(env, actor, u.member_id, u.recovery_email)
    if (r.sent) sent++
    else links.push({ name: u.name, email: u.email, url: r.url })
  }
  await migrationsDb.update(env.DB, m.id, { invites_sent_at: new Date().toISOString() }).run()
  return { sent, links }
}

/** The report as CSV: one row per person and shared drive, then every skipped item with its reason. */
export async function reportCsv(env: Env2, actor: Actor, organizationId: string): Promise<Response> {
  const { m } = await current(env, actor, organizationId, true)
  const users = await migrationsDb.listUsers(env.DB, m.id)
  const drives = await migrationsDb.listDrives(env.DB, m.id)
  const names = new Map<string, string>([...users.map((u) => [u.google_id, `${u.name} <${u.email}>`] as const), ...drives.map((d) => [d.drive_id, `${d.name} (shared drive)`] as const)])
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const rows: unknown[][] = [['Person or drive', 'Email', 'Plan', 'Messages', 'Contacts', 'Calendar events', 'Files', 'Note']]
  for (const u of users) {
    rows.push([
      u.name,
      u.email,
      u.action,
      u.mail_done,
      u.action === 'shared' ? '' : u.contacts_done,
      u.copy_calendar ? u.calendar_done : '',
      u.drive_done,
      u.apply_error ?? u.mail_note ?? u.contacts_note ?? u.calendar_note ?? u.drive_note ?? '',
    ])
  }
  for (const d of drives) rows.push([d.name, '', 'shared drive', '', '', '', d.done, d.note ?? ''])
  rows.push([], ['Skipped item', 'Kind', 'From', 'Google id', 'Reason', 'Detail', 'When'])
  if (m.store_cleared_at) rows.push([`The list of skipped items was deleted on ${m.store_cleared_at.slice(0, 10)}, ${KEEP_AFTER_FINISH_DAYS} days after the import finished.`])
  for (const p of m.store_cleared_at ? [] : await migrationStore(env, organizationId).problems()) {
    rows.push([reasonOf(p.reason).label, p.kind, names.get(p.owner) ?? p.owner, p.sourceId, p.reason, p.detail ?? '', p.at])
  }
  return new Response(rows.map((r) => r.map(cell).join(',')).join('\n') + '\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="google-migration-report-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
