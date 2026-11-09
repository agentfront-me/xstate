-- Copying mail from Gmail (src/migration/mail.ts). Which messages were copied is kept in the MigrationStore
-- Durable Object (one per organization); these columns hold each user's progress and the migration's run state.

ALTER TABLE migrations ADD COLUMN paused_at TEXT;          -- paused by an admin
ALTER TABLE migrations ADD COLUMN access_lost_at TEXT;     -- Google stopped accepting xstate's access mid-copy

ALTER TABLE migration_users ADD COLUMN history_id TEXT;    -- Gmail historyId before copying began (for the final pass)
ALTER TABLE migration_users ADD COLUMN mail_state TEXT CHECK (mail_state IN ('copying', 'done', 'attention'));
ALTER TABLE migration_users ADD COLUMN mail_total INTEGER; -- Gmail's count when copying began (an estimate with a date range)
ALTER TABLE migration_users ADD COLUMN mail_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_users ADD COLUMN mail_skipped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_users ADD COLUMN mail_cursor TEXT;   -- Gmail page token of the next page to copy
-- Bumped on every resume: a job from an older chain stops, so each user has one chain of jobs at a time.
ALTER TABLE migration_users ADD COLUMN mail_chain INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_users ADD COLUMN mail_issue TEXT;    -- 'quota' when the xstate mailbox is full
ALTER TABLE migration_users ADD COLUMN mail_note TEXT;     -- last transient problem, e.g. Google rate limiting
ALTER TABLE migration_users ADD COLUMN mail_updated_at TEXT;
