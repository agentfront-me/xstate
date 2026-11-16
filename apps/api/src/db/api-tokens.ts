// api_tokens and api_token_mailboxes tables: personal API tokens. See migrations/0032_api_tokens.sql.

export type TokenRow = {
  id: string
  organization_id: string
  user_id: string
  name: string
  token_hash: string
  last4: string
  /** JSON array of scopes. */
  scopes: string
  expires_at: string | null
  expiry_notified_at: string | null
  last_used_at: string | null
  revoked_at: string | null
  revoked_by: string | null
  created_at: string
  /** JSON array of the mailbox ids it may send from. */
  mailbox_ids: string
}

const SELECT = `
  SELECT t.*, (SELECT json_group_array(tm.mailbox_id) FROM api_token_mailboxes tm WHERE tm.token_id = t.id) AS mailbox_ids
  FROM api_tokens t`

export function findByHash(db: D1Database, hash: string): Promise<TokenRow | null> {
  return db.prepare(`${SELECT} WHERE t.token_hash = ?`).bind(hash).first<TokenRow>()
}

export function find(db: D1Database, organizationId: string, id: string): Promise<TokenRow | null> {
  return db.prepare(`${SELECT} WHERE t.id = ? AND t.organization_id = ?`).bind(id, organizationId).first<TokenRow>()
}

/** Tokens that aren't revoked, newest first: one person's, or everyone's in the organization. */
export async function list(db: D1Database, organizationId: string, userId?: string): Promise<TokenRow[]> {
  const { results } = await db
    .prepare(`${SELECT} WHERE t.organization_id = ?1 AND t.revoked_at IS NULL AND (?2 IS NULL OR t.user_id = ?2) ORDER BY t.created_at DESC`)
    .bind(organizationId, userId ?? null)
    .all<TokenRow>()
  return results
}

/** How many tokens of this person still work or could work again (not revoked, not expired). */
export async function countLive(db: D1Database, organizationId: string, userId: string, now: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM api_tokens
       WHERE organization_id = ? AND user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(organizationId, userId, now)
    .first<{ n: number }>()
  return row?.n ?? 0
}

const insertMailbox = (db: D1Database, tokenId: string, mailboxId: string) =>
  db.prepare('INSERT INTO api_token_mailboxes (token_id, mailbox_id) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(tokenId, mailboxId)

export async function insert(
  db: D1Database,
  token: {
    id: string
    organizationId: string
    userId: string
    name: string
    hash: string
    last4: string
    scopes: readonly string[]
    expiresAt: string | null
    mailboxIds: readonly string[]
    now: string
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO api_tokens (id, organization_id, user_id, name, token_hash, last4, scopes, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(token.id, token.organizationId, token.userId, token.name, token.hash, token.last4, JSON.stringify(token.scopes), token.expiresAt, token.now),
    ...token.mailboxIds.map((mailboxId) => insertMailbox(db, token.id, mailboxId)),
  ])
}

export async function rename(db: D1Database, id: string, name: string): Promise<void> {
  await db.prepare('UPDATE api_tokens SET name = ? WHERE id = ?').bind(name, id).run()
}

/** Replaces the token's mailboxes in one transaction. */
export async function setMailboxes(db: D1Database, id: string, mailboxIds: readonly string[]): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM api_token_mailboxes WHERE token_id = ?').bind(id),
    ...mailboxIds.map((mailboxId) => insertMailbox(db, id, mailboxId)),
  ])
}

/** Does nothing to a token that is already revoked. */
export async function revoke(db: D1Database, id: string, by: string | null, now: string): Promise<void> {
  await db.prepare('UPDATE api_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').bind(now, by, id).run()
}

/** Revokes every live token a person has in an organization and returns their names (for the email to admins). */
export async function revokeForUser(db: D1Database, organizationId: string, userId: string, by: string | null, now: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `UPDATE api_tokens SET revoked_at = ?, revoked_by = ?
       WHERE organization_id = ? AND user_id = ? AND revoked_at IS NULL RETURNING name, expires_at`,
    )
    .bind(now, by, organizationId, userId)
    .all<{ name: string; expires_at: string | null }>()
  return results.filter((r) => !r.expires_at || r.expires_at > now).map((r) => r.name)
}

/** Records a use, at most once a minute per token so a busy integration isn't a write per request. */
export async function touch(db: D1Database, id: string, now: Date): Promise<void> {
  const minuteAgo = new Date(now.getTime() - 60_000).toISOString()
  await db
    .prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
    .bind(now.toISOString(), id, minuteAgo)
    .run()
}

/** Tokens that end before `before` and whose owner hasn't been told yet. Marks them told, so each gets one email. */
export async function claimExpiring(db: D1Database, now: string, before: string) {
  const { results } = await db
    .prepare(
      `UPDATE api_tokens SET expiry_notified_at = ?1
       WHERE revoked_at IS NULL AND expiry_notified_at IS NULL AND expires_at IS NOT NULL AND expires_at > ?1 AND expires_at <= ?2
       RETURNING id, organization_id, user_id, name, last4, expires_at`,
    )
    .bind(now, before)
    .all<{ id: string; organization_id: string; user_id: string; name: string; last4: string; expires_at: string }>()
  return results
}

/** Removes tokens that were revoked or expired before `before`. Their mailboxes rows go with them. */
export async function purge(db: D1Database, before: string): Promise<number> {
  const result = await db
    .prepare('DELETE FROM api_tokens WHERE (revoked_at IS NOT NULL AND revoked_at < ?1) OR (expires_at IS NOT NULL AND expires_at < ?1)')
    .bind(before)
    .run()
  return result.meta.changes ?? 0
}

export async function tokensDisabled(db: D1Database, organizationId: string): Promise<boolean> {
  const row = await db.prepare('SELECT api_tokens_disabled FROM organizations WHERE id = ?').bind(organizationId).first<{ api_tokens_disabled: number }>()
  return !!row?.api_tokens_disabled
}

export async function setTokensDisabled(db: D1Database, organizationId: string, disabled: boolean): Promise<void> {
  await db
    .prepare('UPDATE organizations SET api_tokens_disabled = ?, updated_at = ? WHERE id = ?')
    .bind(+disabled, new Date().toISOString(), organizationId)
    .run()
}
