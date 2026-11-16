-- Personal API tokens (auth/api-tokens.ts, docs/transactional-api-plan.md). A token belongs to one person in one
-- organization and acts as them, limited to the mailboxes listed for it. It is shown once when created: only its
-- SHA-256 hash is kept, with the last 4 characters so people can tell their tokens apart.
CREATE TABLE api_tokens (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  token_hash          TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the token
  last4               TEXT NOT NULL,
  scopes              TEXT NOT NULL,          -- JSON array, e.g. ["mail.send"]
  expires_at          TEXT,                   -- NULL = no expiry
  expiry_notified_at  TEXT,                   -- when the "expires in a week" email went out
  last_used_at        TEXT,
  revoked_at          TEXT,
  revoked_by          TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX api_tokens_user_idx ON api_tokens (organization_id, user_id);

-- The mailboxes a token may send from. A deleted mailbox leaves the token for good.
CREATE TABLE api_token_mailboxes (
  token_id    TEXT NOT NULL REFERENCES api_tokens (id) ON DELETE CASCADE,
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
  PRIMARY KEY (token_id, mailbox_id)
);
CREATE INDEX api_token_mailboxes_mailbox_idx ON api_token_mailboxes (mailbox_id);

-- Owners and admins can turn personal tokens off for the whole organization.
ALTER TABLE organizations ADD COLUMN api_tokens_disabled INTEGER NOT NULL DEFAULT 0;
