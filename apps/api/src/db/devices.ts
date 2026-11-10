// devices and push_state tables: the phones push notifications go to, and what the sender remembers between jobs.
// See migrations/0028_devices.sql.

export type PushKind = 'email' | 'approvals' | 'agentErrors'

export type DeviceRow = {
  id: string
  user_id: string
  token: string
  platform: 'ios' | 'android'
  notify_email: number
  notify_approvals: number
  notify_agent_errors: number
  domain_id: string | null
  created_at: string
  updated_at: string
}

const COLUMN: Record<PushKind, string> = { email: 'notify_email', approvals: 'notify_approvals', agentErrors: 'notify_agent_errors' }

/**
 * Registers a phone, or updates it. The token is the phone: signing in as someone else on it moves the row to them,
 * so the previous person's notifications stop arriving there.
 */
export async function upsert(
  db: D1Database,
  d: { userId: string; token: string; platform: 'ios' | 'android'; email: boolean; approvals: boolean; agentErrors: boolean; domainId: string | null },
): Promise<DeviceRow> {
  const now = new Date().toISOString()
  const row = await db
    .prepare(
      `INSERT INTO devices (id, user_id, token, platform, notify_email, notify_approvals, notify_agent_errors, domain_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, notify_email = excluded.notify_email,
         notify_approvals = excluded.notify_approvals, notify_agent_errors = excluded.notify_agent_errors, domain_id = excluded.domain_id,
         updated_at = excluded.updated_at
       RETURNING *`,
    )
    .bind(crypto.randomUUID(), d.userId, d.token, d.platform, +d.email, +d.approvals, +d.agentErrors, d.domainId, now, now)
    .first<DeviceRow>()
  return row!
}

/** Signing out: only the person the phone is registered to can remove it. */
export async function removeForUser(db: D1Database, userId: string, token: string): Promise<void> {
  await db.prepare('DELETE FROM devices WHERE token = ? AND user_id = ?').bind(token, userId).run()
}

/** Expo said these tokens are dead (the app was removed). */
export async function removeTokens(db: D1Database, tokens: string[]): Promise<void> {
  for (let i = 0; i < tokens.length; i += 50) {
    const chunk = tokens.slice(i, i + 50)
    await db.prepare(`DELETE FROM devices WHERE token IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk).run()
  }
}

/**
 * The phones of these people that have this kind of notification switched on. `domainId` (new mail): phones narrowed
 * to another domain are left out.
 */
export async function forUsers(db: D1Database, userIds: string[], kind: PushKind, domainId?: string): Promise<DeviceRow[]> {
  const ids = [...new Set(userIds)].slice(0, 90)
  if (!ids.length) return []
  const { results } = await db
    .prepare(
      `SELECT * FROM devices WHERE user_id IN (${ids.map(() => '?').join(', ')}) AND ${COLUMN[kind]} = 1
       ${domainId ? 'AND (domain_id IS NULL OR domain_id = ?)' : ''}`,
    )
    .bind(...ids, ...(domainId ? [domainId] : []))
    .all<DeviceRow>()
  return results
}

export async function getState(db: D1Database, key: string): Promise<string | null> {
  return (await db.prepare('SELECT value FROM push_state WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO push_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, value, new Date().toISOString())
    .run()
}

/** True at most once per `seconds` for a key: the caller sends only when it is. */
export async function throttle(db: D1Database, key: string, seconds: number): Promise<boolean> {
  const now = Date.now()
  const result = await db
    .prepare(
      `INSERT INTO push_state (key, value, updated_at) VALUES (?, '', ?)
       ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at WHERE push_state.updated_at < ?`,
    )
    .bind(key, new Date(now).toISOString(), new Date(now - seconds * 1000).toISOString())
    .run()
  return result.meta.changes > 0
}
