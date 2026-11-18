-- The delivery log's lines for received mail that reached no mailbox (docs/mailbox-store-plan.md, phase 2 step 4d):
-- an address that doesn't exist, or a mailbox not on the new mail path. Lines for delivered mail live in each
-- mailbox's store. Ids, addresses and outcomes only, never content; kept 30 days.
CREATE TABLE mail_drops (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  ses_id TEXT NOT NULL,
  at TEXT NOT NULL,
  sender TEXT,
  recipient TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX mail_drops_org ON mail_drops (organization_id, at);
CREATE INDEX mail_drops_at ON mail_drops (at);
