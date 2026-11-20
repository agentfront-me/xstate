// app_passwords table: how mail and calendar apps sign in. See migrations/0047_app_passwords.sql.

export type AppPasswordRow = {
  id: string
  organization_id: string
  user_id: string
  name: string
  password_hash: string
  last_used_at: string | null
  revoked_at: string | null
  revoked_by: string | null
  created_at: string
}

export function findByHash(db: D1Database, hash: string): Promise<AppPasswordRow | null> {
  return db.prepare('SELECT * FROM app_passwords WHERE password_hash = ?').bind(hash).first<AppPasswordRow>()
}

export function find(db: D1Database, organizationId: string, id: string): Promise<AppPasswordRow | null> {
  return db.prepare('SELECT * FROM app_passwords WHERE id = ? AND organization_id = ?').bind(id, organizationId).first<AppPasswordRow>()
}

/** App passwords that aren't revoked, newest first: one person's, or everyone's in the organization. */
export async function list(db: D1Database, organizationId: string, userId?: string): Promise<AppPasswordRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM app_passwords WHERE organization_id = ?1 AND revoked_at IS NULL AND (?2 IS NULL OR user_id = ?2) ORDER BY created_at DESC')
    .bind(organizationId, userId ?? null)
    .all<AppPasswordRow>()
  return results
}

export async function countLive(db: D1Database, organizationId: string, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM app_passwords WHERE organization_id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(organizationId, userId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function insert(db: D1Database, row: Pick<AppPasswordRow, 'id' | 'organization_id' | 'user_id' | 'name' | 'password_hash' | 'created_at'>): Promise<void> {
  await db
    .prepare('INSERT INTO app_passwords (id, organization_id, user_id, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.organization_id, row.user_id, row.name, row.password_hash, row.created_at)
    .run()
}

export async function revoke(db: D1Database, id: string, by: string | null, now: string): Promise<void> {
  await db.prepare('UPDATE app_passwords SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').bind(now, by, id).run()
}

/** Revokes every app password a person has in an organization. Returns how many. */
export async function revokeForUser(db: D1Database, organizationId: string, userId: string, by: string | null, now: string): Promise<number> {
  const result = await db
    .prepare('UPDATE app_passwords SET revoked_at = ?, revoked_by = ? WHERE organization_id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(now, by, organizationId, userId)
    .run()
  return result.meta.changes ?? 0
}

/** Records a use, at most once a minute per password: a mail app signs in many times an hour. */
export async function touch(db: D1Database, id: string, now: Date): Promise<void> {
  const minuteAgo = new Date(now.getTime() - 60_000).toISOString()
  await db
    .prepare('UPDATE app_passwords SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
    .bind(now.toISOString(), id, minuteAgo)
    .run()
}

/** Removes app passwords revoked before `before`. */
export async function purge(db: D1Database, before: string): Promise<number> {
  const result = await db.prepare('DELETE FROM app_passwords WHERE revoked_at IS NOT NULL AND revoked_at < ?').bind(before).run()
  return result.meta.changes ?? 0
}

export async function appsDisabled(db: D1Database, organizationId: string): Promise<boolean> {
  const row = await db.prepare('SELECT mail_apps_disabled FROM organizations WHERE id = ?').bind(organizationId).first<{ mail_apps_disabled: number }>()
  return !!row?.mail_apps_disabled
}

export async function setAppsDisabled(db: D1Database, organizationId: string, disabled: boolean): Promise<void> {
  await db
    .prepare('UPDATE organizations SET mail_apps_disabled = ?, updated_at = ? WHERE id = ?')
    .bind(+disabled, new Date().toISOString(), organizationId)
    .run()
}
