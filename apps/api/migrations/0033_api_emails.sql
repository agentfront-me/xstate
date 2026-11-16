-- The send log for POST /v1/emails (emails/service.ts, docs/transactional-api-plan.md): one row per message sent
-- with a personal API token, and one per recipient with its delivery status. Bodies and attachments are not kept.
-- Rows are removed 30 days after they were sent.
CREATE TABLE api_emails (
  id               TEXT PRIMARY KEY,          -- em_…
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mailbox_id       TEXT REFERENCES mailboxes (id) ON DELETE SET NULL,
  token_id         TEXT REFERENCES api_tokens (id) ON DELETE SET NULL,
  user_id          TEXT REFERENCES users (id) ON DELETE SET NULL,
  from_email       TEXT NOT NULL,
  from_name        TEXT,
  subject          TEXT NOT NULL,
  tags             TEXT NOT NULL DEFAULT '{}', -- JSON object of the caller's own labels
  saved_to_sent    INTEGER NOT NULL DEFAULT 0,
  message_id       TEXT NOT NULL UNIQUE,      -- the Message-ID header, to match delivery events to the message
  idempotency_key  TEXT,                      -- honoured for 24 hours
  request_hash     TEXT,                      -- tells a retry of the same request from a different one
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX api_emails_idem_idx ON api_emails (token_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX api_emails_user_idx ON api_emails (organization_id, user_id, created_at);
CREATE INDEX api_emails_from_idx ON api_emails (from_email, created_at);

CREATE TABLE api_email_recipients (
  email_id    TEXT NOT NULL REFERENCES api_emails (id) ON DELETE CASCADE,
  address     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('to', 'cc', 'bcc')),
  -- queued: being sent. sent: handed to the mail server. delivered, bounced, complained: from Amazon SES.
  -- suppressed: not sent, because the address bounced before or complained.
  status      TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'bounced', 'complained', 'suppressed')),
  detail      TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (email_id, address)
);
CREATE INDEX api_email_recipients_address_idx ON api_email_recipients (address, status);
