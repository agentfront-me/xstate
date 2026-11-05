-- Files in R2. Each organization has its own bucket; each mailbox has its own folder in it:
--   <bucket>/<mailbox id>/<yyyy>/<mm>/<file id>/<file name>
-- Stalwart keeps the full messages (attachments included) in its own blob store; these are xstate's copies of
-- attachments, plus files uploaded for sending. See docs/message-api-plan.md.

-- The organization's R2 bucket. NULL until it has been created (lazily, if creating it at sign-up failed).
ALTER TABLE organizations ADD COLUMN r2_bucket TEXT;

-- Last JMAP Email state copied per mailbox, so attachment ingestion resumes where it stopped.
CREATE TABLE mailbox_sync (
  mailbox_id   TEXT PRIMARY KEY REFERENCES mailboxes (id) ON DELETE CASCADE,
  email_state  TEXT,
  synced_at    TEXT
);

-- Every file in R2: attachments of received and sent mail, and uploads waiting to be sent.
CREATE TABLE files (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mailbox_id        TEXT,                     -- NULL for future files that aren't mail
  r2_key            TEXT NOT NULL,            -- '<mailbox id>/2026/11/<file id>/invoice.pdf'; the bucket is the org's
  name              TEXT NOT NULL,            -- file name as sent, cleaned for display
  content_type      TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  sha256            TEXT,                     -- hex, set once the bytes are in R2
  source            TEXT NOT NULL CHECK (source IN ('received', 'sent', 'upload')),
  status            TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('pending', 'ready', 'deleted')),
  email_id          TEXT,                     -- Stalwart Email id (unique only within the mailbox)
  thread_id         TEXT,
  part_id           TEXT,                     -- MIME part within the message
  stalwart_blob_id  TEXT,
  disposition       TEXT CHECK (disposition IN ('attachment', 'inline')),
  content_id        TEXT,                     -- for inline images referenced as cid:
  created_by        TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  deleted_at        TEXT,
  FOREIGN KEY (mailbox_id, organization_id) REFERENCES mailboxes (id, organization_id) ON DELETE CASCADE
);
-- One row per attachment part, so a retried ingestion job can't create a second copy.
CREATE UNIQUE INDEX files_part_uniq ON files (mailbox_id, email_id, part_id) WHERE email_id IS NOT NULL;
CREATE INDEX files_mailbox_idx ON files (mailbox_id, created_at);
CREATE INDEX files_email_idx ON files (mailbox_id, email_id);
CREATE INDEX files_org_idx ON files (organization_id);
