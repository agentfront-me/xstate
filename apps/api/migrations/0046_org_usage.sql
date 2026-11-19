-- Plan usage counters (docs/billing-limits-plan.md §3.3, src/usage/). One row per organization, made on first use.
-- The active audience and website events live in each organization's AudienceStore, not here.
CREATE TABLE org_usage (
  organization_id TEXT PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  -- Raw mail kept in the organization's mailboxes (each message once, attachments included), in bytes. Grows as mail
  -- arrives or is sent (mailbox/events.ts); the daily recount (usage/storage.ts) sets it exactly, deletions included.
  mail_bytes INTEGER NOT NULL DEFAULT 0,
  mail_checked_at TEXT,
  -- Recipients mailed this calendar month (UTC 'YYYY-MM'), every recipient counted (mailserver/sending.ts).
  emails_month TEXT,
  emails_count INTEGER NOT NULL DEFAULT 0,
  -- Phase 5 (limits): when each limit was first over, and which notices went out. JSON objects.
  over_since TEXT,
  notified TEXT,
  updated_at TEXT NOT NULL
);

-- Searchable emails per organization (the Growth search cap) and Storage file totals are counted from these.
CREATE INDEX search_docs_org_status_idx ON search_docs (organization_id, status);
