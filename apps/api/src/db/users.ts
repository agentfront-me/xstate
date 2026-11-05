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
