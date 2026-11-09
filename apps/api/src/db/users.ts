// users table: people who sign in to xstate.

export type UserRow = {
  id: string
  email: string
  name: string | null
  password_hash: string | null
  google_sub: string | null
  created_at: string
  updated_at: string
}

export function findById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>()
}

export function findByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>()
}

export function insert(
  db: D1Database,
  user: { id: string; email: string; name: string; passwordHash: string; now: string },
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(user.id, user.email, user.name, user.passwordHash, user.now, user.now)
}

/** Someone invited to an organization who has no xstate account yet: no password until they accept. */
export function insertInvited(db: D1Database, user: { id: string; email: string; name: string | null; now: string }): D1PreparedStatement {
  return db
    .prepare('INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(user.id, user.email, user.name, user.now, user.now)
}

/** Sets the password, and the name if they give one. Only while there's no password yet (accepting an invite). */
/** Deletes an invited user who never set a password and belongs to no organization (any more). */
export function removeIfUnclaimed(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare('DELETE FROM users WHERE id = ? AND password_hash IS NULL AND NOT EXISTS (SELECT 1 FROM members WHERE user_id = users.id)').bind(id)
}

/** Deletes an invited user whose every invitation has expired, so the email can sign up afresh. */
export function removeIfLapsed(db: D1Database, id: string, now: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM users WHERE id = ? AND password_hash IS NULL
         AND NOT EXISTS (SELECT 1 FROM invitations i JOIN members m ON m.id = i.member_id WHERE m.user_id = users.id AND i.expires_at > ?)`,
    )
    .bind(id, now)
}

export function setFirstPassword(db: D1Database, id: string, passwordHash: string, name: string | null, now: string): D1PreparedStatement {
  return db
    .prepare('UPDATE users SET password_hash = ?, name = COALESCE(?, name), updated_at = ? WHERE id = ? AND password_hash IS NULL')
    .bind(passwordHash, name, now, id)
}
