// users table: people who sign in to xstate.

export type UserRow = {
  id: string
  email: string
  name: string | null
  password_hash: string | null
  google_sub: string | null
  /** Where invites and password reset links go when `email` is a mailbox they can't read yet (migrations/0040). */
  recovery_email: string | null
  /** 1 after an admin set a temporary password: signing in only lets them choose a new one. */
  must_change_password: number
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

/**
 * Someone added with a mailbox: `email` is its primary address. With `passwordHash` (a temporary password an admin
 * set) they must choose a new one when they first sign in; without one they set it through their invite link.
 */
export function insertWithMailbox(
  db: D1Database,
  user: { id: string; email: string; name: string; recoveryEmail: string | null; passwordHash: string | null; now: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO users (id, email, name, password_hash, recovery_email, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(user.id, user.email, user.name, user.passwordHash, user.recoveryEmail, user.passwordHash ? 1 : 0, user.now, user.now)
}

export function remove(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare('DELETE FROM users WHERE id = ?').bind(id)
}

export function update(db: D1Database, id: string, changes: { name?: string; recoveryEmail?: string | null }, now: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET name = COALESCE(?, name),
         recovery_email = CASE WHEN ? THEN ? ELSE recovery_email END, updated_at = ? WHERE id = ?`,
    )
    .bind(changes.name ?? null, changes.recoveryEmail !== undefined ? 1 : 0, changes.recoveryEmail ?? null, now, id)
}

/** The sign-in address follows the primary address of their mailbox. */
export function setEmail(db: D1Database, id: string, email: string, now: string): D1PreparedStatement {
  return db.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').bind(email, now, id)
}

/** Their own new password, which ends a temporary one. */
export function setPassword(db: D1Database, id: string, passwordHash: string, now: string): D1PreparedStatement {
  return db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').bind(passwordHash, now, id)
}
