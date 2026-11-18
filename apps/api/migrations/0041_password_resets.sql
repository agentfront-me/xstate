-- Password reset links an admin emails to a member (docs/members-plan.md, phase 2). One open link per user: sending
-- a new one replaces the old. Only the SHA-256 of the token in the link is stored.
CREATE TABLE password_resets (
  user_id     TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
