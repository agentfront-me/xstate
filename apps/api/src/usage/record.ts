// Recording plan usage as it happens (docs/billing-limits-plan.md §3.3). Every function here only counts; none of them
// refuses anything (that's phase 5, limits/). They never fail the caller: a lost count is logged and the daily recount
// (./storage.ts) repairs storage. The active audience and website events are kept in the organization's AudienceStore.

export type UsageEnv = Pick<Env, 'DB' | 'AUDIENCE'>

export const monthOf = (at: number | string | Date = Date.now()) => new Date(at).toISOString().slice(0, 7)

/** Everyone on a sent or received message counts toward this month's active audience. */
export async function recordActiveAudience(env: UsageEnv, organizationId: string, emails: string[], at: number = Date.now()): Promise<void> {
  if (!emails.length) return
  try {
    await env.AUDIENCE.get(env.AUDIENCE.idFromName(organizationId)).recordActive(emails, at)
  } catch (err) {
    console.error('usage: active audience failed', organizationId, err)
  }
}

/** Raw mail stored (arrived or sent). Deletions are caught by the daily recount. */
export async function addStorageBytes(env: Pick<Env, 'DB'>, organizationId: string, bytes: number): Promise<void> {
  if (!(bytes > 0)) return
  try {
    await env.DB.prepare(
      `INSERT INTO org_usage (organization_id, mail_bytes, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (organization_id) DO UPDATE SET mail_bytes = mail_bytes + excluded.mail_bytes, updated_at = excluded.updated_at`,
    )
      .bind(organizationId, Math.round(bytes), new Date().toISOString())
      .run()
  } catch (err) {
    console.error('usage: storage count failed', organizationId, err)
  }
}

/**
 * Statement that adds `recipients` to this month's email count (every recipient, inside and outside the
 * organization). Run in the same batch as the send reservation (mailserver/sending.ts), undone with emailsUndo.
 */
export function emailsAdd(db: D1Database, organizationId: string, recipients: number, month = monthOf()): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO org_usage (organization_id, emails_month, emails_count, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (organization_id) DO UPDATE SET
         emails_count = CASE WHEN emails_month IS excluded.emails_month THEN emails_count + excluded.emails_count ELSE excluded.emails_count END,
         emails_month = excluded.emails_month, updated_at = excluded.updated_at`,
    )
    .bind(organizationId, month, recipients, new Date().toISOString())
}

export function emailsUndo(db: D1Database, organizationId: string, recipients: number, month = monthOf()): D1PreparedStatement {
  return db
    .prepare('UPDATE org_usage SET emails_count = max(0, emails_count - ?) WHERE organization_id = ? AND emails_month = ?')
    .bind(recipients, organizationId, month)
}
