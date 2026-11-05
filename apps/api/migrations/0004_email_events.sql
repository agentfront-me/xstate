-- Bounces and complaints reported by Amazon SES (through SNS to POST /webhooks/ses), and the addresses we no longer
-- send to because of them. See jobs/ses-webhook.ts.

CREATE TABLE email_events (
  id               TEXT PRIMARY KEY,           -- SNS MessageId, so a redelivered notification isn't counted twice
  organization_id  TEXT REFERENCES organizations (id) ON DELETE CASCADE,
  mailbox_id       TEXT REFERENCES mailboxes (id) ON DELETE SET NULL,
  type             TEXT NOT NULL CHECK (type IN ('bounce', 'complaint')),
  subtype          TEXT,                       -- bounce: Permanent / Transient / Undetermined; complaint: feedback type
  sender           TEXT NOT NULL,              -- the xstate address that sent the message
  recipient        TEXT NOT NULL,
  detail           TEXT,                       -- e.g. the receiving server's diagnostic code
  ses_message_id   TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX email_events_mailbox_idx ON email_events (mailbox_id, type, created_at);
CREATE INDEX email_events_org_idx ON email_events (organization_id, created_at);

-- Recipients to refuse before sending. organization_id '' means everyone (the address doesn't exist: a permanent
-- bounce); otherwise only that organization (the recipient complained about its mail).
CREATE TABLE suppressions (
  address          TEXT NOT NULL,              -- lowercase
  organization_id  TEXT NOT NULL DEFAULT '',
  reason           TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint')),
  detail           TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (address, organization_id)
);
