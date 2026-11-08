-- Outbound sending limits and abuse suspension. See mailserver/sending.ts.
--
-- One free account sending spam can get the whole Amazon SES account reviewed or paused (SES reviews at about a 5%
-- bounce rate or a 0.1% complaint rate), which would stop mail for every customer. So:
--   - email_send counts outside recipients per mailbox and organization and refuses past an hourly and daily cap;
--     mail apps sending over SMTP are capped by Stalwart's own throttles (scripts/stalwart-limits.sh);
--   - bounces, complaints and SES delivery counts decide when a mailbox or a whole organization is suspended.

-- Recipients email_send has accepted, for the hourly and daily caps. Pruned after two days by the hourly cron.
CREATE TABLE send_log (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mailbox_id       TEXT NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
  recipients       INTEGER NOT NULL,           -- outside recipients only: mail between xstate domains stays local
  created_at       TEXT NOT NULL
);
CREATE INDEX send_log_org_idx ON send_log (organization_id, created_at);

-- Recipients SES delivered per mailbox per UTC day, from SES delivery notifications. This is the denominator for
-- bounce and complaint rates, and covers every sending path (API, SMTP, Stalwart's own mail). Kept 30 days.
CREATE TABLE delivery_counts (
  mailbox_id       TEXT NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  day              TEXT NOT NULL,              -- 'YYYY-MM-DD'
  delivered        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mailbox_id, day)
);
CREATE INDEX delivery_counts_org_idx ON delivery_counts (organization_id, day);

-- A mailbox (mailbox_id set) or a whole organization (mailbox_id NULL) that may not send. Set automatically from
-- bounce and complaint rates; lifted by an operator setting lifted_at (the hourly cron then re-enables Stalwart).
CREATE TABLE sending_suspensions (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mailbox_id       TEXT REFERENCES mailboxes (id) ON DELETE CASCADE,
  reason           TEXT NOT NULL CHECK (reason IN ('bounces', 'complaints', 'manual')),
  detail           TEXT,
  created_at       TEXT NOT NULL,
  lifted_at        TEXT,
  lifted_note      TEXT
);
-- At most one active suspension per mailbox, and one per organization.
CREATE UNIQUE INDEX sending_suspensions_active ON sending_suspensions (organization_id, coalesce(mailbox_id, ''))
  WHERE lifted_at IS NULL;

-- Stalwart accounts whose sending permissions (emailSend, jmapEmailSubmissionCreate) we turned off because of a
-- suspension, so they can be turned back on exactly when it's lifted.
CREATE TABLE sending_blocks (
  stalwart_id      TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
