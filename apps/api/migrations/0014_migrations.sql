-- Imports from Google Workspace (src/migration/). One active migration per organization; finished and cancelled
-- ones stay for their report. JSON columns are TEXT.

CREATE TABLE migrations (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished', 'cancelled')),
  -- The wizard step the admin is on (apps/app/src/migration/types.ts Stage).
  stage             TEXT NOT NULL DEFAULT 'connect',
  started_by        TEXT REFERENCES users (id) ON DELETE SET NULL,
  -- Connect: the Workspace super admin xstate acts as for directory reads, and which permissions passed.
  admin_email       TEXT,
  checks            TEXT,                       -- {"directory": true, "gmail": false, ...}
  verified_at       TEXT,
  -- Discover: runs in the background (xstate-migration queue). Groups, shared drives and domains are small
  -- enough to keep as JSON here; users get a row each in migration_users.
  discovery_state   TEXT NOT NULL DEFAULT 'idle' CHECK (discovery_state IN ('idle', 'running', 'done', 'failed')),
  discovery_error   TEXT,
  discovered_at     TEXT,
  google_domain     TEXT,                       -- the Workspace's primary domain
  groups            TEXT,                       -- [{id, email, name, members, memberEmails, aliases, mailboxId?}]
  drives            TEXT,                       -- [{id, name, members}]
  domains           TEXT,                       -- [{name, kind}]
  -- Plan: per-user choices live on migration_users; these are the rest.
  plan_groups       TEXT,                       -- {"<group id>": true}
  plan_drives       TEXT,                       -- {"<drive id>": true}
  mail_range        TEXT NOT NULL DEFAULT 'all' CHECK (mail_range IN ('all', '5y', '3y', '1y')),
  -- Start: creating members, mailboxes, aliases and shared mailboxes from the plan (in the background).
  apply_state       TEXT NOT NULL DEFAULT 'idle' CHECK (apply_state IN ('idle', 'running', 'done', 'failed')),
  apply_error       TEXT,
  started_at        TEXT,
  last_seen_at      TEXT,
  finished_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX migrations_one_active ON migrations (organization_id) WHERE status = 'active';

-- One row per Google user found by discovery.
CREATE TABLE migration_users (
  migration_id         TEXT NOT NULL REFERENCES migrations (id) ON DELETE CASCADE,
  google_id            TEXT NOT NULL,
  email                TEXT NOT NULL,
  name                 TEXT NOT NULL,
  suspended            INTEGER NOT NULL DEFAULT 0,  -- suspended or archived in Google
  aliases              TEXT NOT NULL DEFAULT '[]',
  -- Counts. Sizes come from Google's usage report (a few days old); null = not counted (yet, or not possible).
  mail_bytes           INTEGER,
  drive_bytes          INTEGER,
  messages             INTEGER,
  contacts             INTEGER,
  files                INTEGER,
  counted_at           TEXT,
  count_error          TEXT,
  -- Plan
  action               TEXT NOT NULL DEFAULT 'create' CHECK (action IN ('create', 'existing', 'shared', 'skip')),
  existing_address     TEXT,                        -- action 'existing': the xstate mailbox to copy into
  copy_mail            INTEGER NOT NULL DEFAULT 1,
  copy_contacts        INTEGER NOT NULL DEFAULT 1,
  copy_drive           INTEGER NOT NULL DEFAULT 1,
  -- What Start created or picked for this user.
  member_id            TEXT REFERENCES members (id) ON DELETE SET NULL,
  mailbox_id           TEXT REFERENCES mailboxes (id) ON DELETE SET NULL,
  applied_at           TEXT,
  apply_error          TEXT,
  PRIMARY KEY (migration_id, google_id)
);
