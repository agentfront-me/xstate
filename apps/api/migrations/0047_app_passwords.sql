-- App passwords (auth/app-passwords.ts, docs/imap-smtp-relay-plan.md §4): how a mail or calendar app signs in, since
-- it can't do the web sign-in. One belongs to a person in an organization and works for every mailbox that person can
-- open, with the access they have at that moment; the app gives the mailbox's address as the username. Shown once
-- when created: only the SHA-256 hash is kept.
CREATE TABLE app_passwords (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,             -- "iPhone Mail"
  password_hash    TEXT NOT NULL UNIQUE,      -- hex SHA-256 of the 16 letters
  last_used_at     TEXT,
  revoked_at       TEXT,
  revoked_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX app_passwords_user_idx ON app_passwords (organization_id, user_id);

-- Owners and admins can turn mail and calendar apps off for the whole organization.
ALTER TABLE organizations ADD COLUMN mail_apps_disabled INTEGER NOT NULL DEFAULT 0;
