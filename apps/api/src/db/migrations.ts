// migrations and migration_users tables: imports from Google Workspace. See migrations/0014_migrations.sql.

export type MigrationRow = {
  id: string
  organization_id: string
  status: 'active' | 'finished' | 'cancelled'
  stage: string
  started_by: string | null
  admin_email: string | null
  checks: string | null
  verified_at: string | null
  discovery_state: 'idle' | 'running' | 'done' | 'failed'
  discovery_error: string | null
  discovered_at: string | null
  google_domain: string | null
  groups: string | null
  drives: string | null
  domains: string | null
  plan_groups: string | null
  plan_drives: string | null
  mail_range: 'all' | '5y' | '3y' | '1y'
  apply_state: 'idle' | 'running' | 'done' | 'failed'
  apply_error: string | null
  started_at: string | null
  last_seen_at: string | null
  finished_at: string | null
  paused_at: string | null
  access_lost_at: string | null
  switch_ttl_done: number
  switch_detected_at: string | null
  final_state: 'running' | 'done' | null
  final_runs: number
  final_started_at: string | null
  final_rerun_at: string | null
  access_checked_at: string | null
  access_removed_at: string | null
  invites_sent_at: string | null
  watch: string | null
  copied_notified_at: string | null
  store_cleared_at: string | null
  created_at: string
  updated_at: string
}

export type Action = 'create' | 'existing' | 'shared' | 'skip'

export type MigrationUserRow = {
  migration_id: string
  google_id: string
  email: string
  name: string
  suspended: number
  aliases: string
  mail_bytes: number | null
  drive_bytes: number | null
  messages: number | null
  contacts: number | null
  files: number | null
  counted_at: string | null
  count_error: string | null
  action: Action
  existing_address: string | null
  copy_mail: number
  copy_contacts: number
  copy_drive: number
  member_id: string | null
  mailbox_id: string | null
  applied_at: string | null
  apply_error: string | null
  history_id: string | null
  mail_state: 'copying' | 'done' | 'attention' | null
  mail_total: number | null
  mail_done: number
  mail_skipped: number
  mail_cursor: string | null
  mail_chain: number
  mail_issue: 'quota' | 'suspended' | 'error' | null
  mail_note: string | null
  mail_updated_at: string | null
  contacts_state: 'copying' | 'done' | 'attention' | null
  contacts_total: number | null
  contacts_done: number
  contacts_cursor: string | null
  contacts_chain: number
  contacts_note: string | null
  drive_state: 'copying' | 'done' | 'attention' | null
  drive_done: number
  drive_copied_bytes: number
  drive_cursor: string | null
  drive_chain: number
  drive_note: string | null
  drive_root: string | null
  recovery_email: string | null
  drive_changes_token: string | null
  final_mail: 'running' | 'done' | null
  final_mail_changes: number
  final_mail_cursor: string | null
  final_drive: 'running' | 'done' | null
  final_drive_changes: number
  final_contacts_base: number | null
  watch: string | null
}

export type MigrationDriveRow = {
  migration_id: string
  drive_id: string
  name: string
  folder_id: string | null
  state: 'copying' | 'done' | 'attention' | null
  done: number
  bytes: number
  cursor: string | null
  chain: number
  note: string | null
  changes_token: string | null
  final_state: 'running' | 'done' | null
  final_changes: number
  watch: string | null
}

export async function listDrives(db: D1Database, migrationId: string): Promise<MigrationDriveRow[]> {
  const { results } = await db.prepare('SELECT * FROM migration_drives WHERE migration_id = ? ORDER BY name').bind(migrationId).all<MigrationDriveRow>()
  return results
}

export function findActive(db: D1Database, organizationId: string): Promise<MigrationRow | null> {
  return db.prepare("SELECT * FROM migrations WHERE organization_id = ? AND status = 'active'").bind(organizationId).first<MigrationRow>()
}

/** The active migration, or else the latest finished one (its Done screen and report stay available). */
export function findCurrent(db: D1Database, organizationId: string): Promise<MigrationRow | null> {
  return db
    .prepare(
      `SELECT * FROM migrations WHERE organization_id = ? AND status IN ('active', 'finished')
       ORDER BY status = 'active' DESC, created_at DESC LIMIT 1`,
    )
    .bind(organizationId)
    .first<MigrationRow>()
}

export function find(db: D1Database, id: string): Promise<MigrationRow | null> {
  return db.prepare('SELECT * FROM migrations WHERE id = ?').bind(id).first<MigrationRow>()
}

export function insert(db: D1Database, m: { id: string; organizationId: string; startedBy: string; now: string }): D1PreparedStatement {
  return db
    .prepare('INSERT INTO migrations (id, organization_id, started_by, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(m.id, m.organizationId, m.startedBy, m.now, m.now, m.now)
}

type Patch = Partial<Omit<MigrationRow, 'id' | 'organization_id' | 'created_at'>>

/** Sets the given columns (and updated_at). */
export function update(db: D1Database, id: string, patch: Patch): D1PreparedStatement {
  const entries = Object.entries({ ...patch, updated_at: new Date().toISOString() })
  return db
    .prepare(`UPDATE migrations SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .bind(...entries.map(([, v]) => v ?? null), id)
}

export async function listUsers(db: D1Database, migrationId: string): Promise<MigrationUserRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM migration_users WHERE migration_id = ? ORDER BY suspended, name COLLATE NOCASE')
    .bind(migrationId)
    .all<MigrationUserRow>()
  return results
}

export function findUser(db: D1Database, migrationId: string, googleId: string): Promise<MigrationUserRow | null> {
  return db.prepare('SELECT * FROM migration_users WHERE migration_id = ? AND google_id = ?').bind(migrationId, googleId).first<MigrationUserRow>()
}

/**
 * Adds a user found by discovery, or refreshes one found before. A refresh updates what Google says (name,
 * aliases, sizes) and clears the counts so they're taken again, but keeps the admin's plan for that user.
 */
export function upsertUser(
  db: D1Database,
  u: {
    migrationId: string
    googleId: string
    email: string
    name: string
    suspended: boolean
    aliases: string[]
    mailBytes: number | null
    driveBytes: number | null
    countedAt: string | null
    countError: string | null
    plan: { action: Action; existingAddress: string | null; mail: boolean; contacts: boolean; drive: boolean }
    recoveryEmail?: string | null
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO migration_users (migration_id, google_id, email, name, suspended, aliases, mail_bytes, drive_bytes,
         counted_at, count_error, action, existing_address, copy_mail, copy_contacts, copy_drive, recovery_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (migration_id, google_id) DO UPDATE SET email = excluded.email, name = excluded.name,
         suspended = excluded.suspended, aliases = excluded.aliases, mail_bytes = excluded.mail_bytes,
         drive_bytes = excluded.drive_bytes, messages = NULL, contacts = NULL, files = NULL,
         counted_at = excluded.counted_at, count_error = excluded.count_error, recovery_email = excluded.recovery_email`,
    )
    .bind(
      u.migrationId,
      u.googleId,
      u.email,
      u.name,
      u.suspended ? 1 : 0,
      JSON.stringify(u.aliases),
      u.mailBytes,
      u.driveBytes,
      u.countedAt,
      u.countError,
      u.plan.action,
      u.plan.existingAddress,
      u.plan.mail ? 1 : 0,
      u.plan.contacts ? 1 : 0,
      u.plan.drive ? 1 : 0,
      u.recoveryEmail ?? null,
    )
}

/** Drops users Google no longer lists (deleted since the last count). */
export function removeUsersExcept(db: D1Database, migrationId: string, googleIds: string[]): D1PreparedStatement {
  return db
    .prepare('DELETE FROM migration_users WHERE migration_id = ? AND google_id NOT IN (SELECT value FROM json_each(?))')
    .bind(migrationId, JSON.stringify(googleIds))
}

export function setCounts(
  db: D1Database,
  migrationId: string,
  googleId: string,
  c: { messages: number | null; contacts: number | null; files: number | null; error: string | null },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE migration_users SET messages = ?, contacts = ?, files = ?, count_error = ?, counted_at = ?
       WHERE migration_id = ? AND google_id = ?`,
    )
    .bind(c.messages, c.contacts, c.files, c.error, new Date().toISOString(), migrationId, googleId)
}

export async function uncounted(db: D1Database, migrationId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM migration_users WHERE migration_id = ? AND counted_at IS NULL').bind(migrationId).first<{ n: number }>()
  return row?.n ?? 0
}

export function setPlan(
  db: D1Database,
  migrationId: string,
  googleId: string,
  p: { action: Action; existingAddress: string | null; mail: boolean; contacts: boolean; drive: boolean },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE migration_users SET action = ?, existing_address = ?, copy_mail = ?, copy_contacts = ?, copy_drive = ?
       WHERE migration_id = ? AND google_id = ?`,
    )
    .bind(p.action, p.existingAddress, p.mail ? 1 : 0, p.contacts ? 1 : 0, p.drive ? 1 : 0, migrationId, googleId)
}

/** Users Start hasn't handled yet, a few at a time. */
export async function unapplied(db: D1Database, migrationId: string, limit: number): Promise<MigrationUserRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM migration_users WHERE migration_id = ? AND applied_at IS NULL ORDER BY suspended, email LIMIT ?')
    .bind(migrationId, limit)
    .all<MigrationUserRow>()
  return results
}

export function setApplied(
  db: D1Database,
  migrationId: string,
  googleId: string,
  r: { memberId: string | null; mailboxId: string | null; error: string | null },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE migration_users SET member_id = ?, mailbox_id = ?, apply_error = ?, applied_at = ?
       WHERE migration_id = ? AND google_id = ?`,
    )
    .bind(r.memberId, r.mailboxId, r.error, new Date().toISOString(), migrationId, googleId)
}

export async function applyCounts(db: D1Database, migrationId: string) {
  return (await db
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(applied_at) AS done, COUNT(apply_error) AS failed
       FROM migration_users WHERE migration_id = ?`,
    )
    .bind(migrationId)
    .first<{ total: number; done: number; failed: number }>())!
}
