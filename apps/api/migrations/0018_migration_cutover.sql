-- Switching over, the final sync and finishing (src/migration/final.ts, finish.ts).

ALTER TABLE migrations ADD COLUMN switch_ttl_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migrations ADD COLUMN switch_detected_at TEXT;   -- when xstate's records were first all found
ALTER TABLE migrations ADD COLUMN final_state TEXT CHECK (final_state IN ('running', 'done'));
ALTER TABLE migrations ADD COLUMN final_runs INTEGER NOT NULL DEFAULT 0;   -- 1 after the first pass, 2 after the rerun
ALTER TABLE migrations ADD COLUMN final_started_at TEXT;
ALTER TABLE migrations ADD COLUMN final_rerun_at TEXT;       -- the automatic second pass, 24 hours after the first
ALTER TABLE migrations ADD COLUMN access_checked_at TEXT;    -- Finish: last check whether Google access is gone
ALTER TABLE migrations ADD COLUMN access_removed_at TEXT;
ALTER TABLE migrations ADD COLUMN invites_sent_at TEXT;

ALTER TABLE migration_users ADD COLUMN recovery_email TEXT;  -- where their invite goes (their xstate address can't be read yet)
ALTER TABLE migration_users ADD COLUMN drive_changes_token TEXT;   -- Drive's change feed position when the copy began
ALTER TABLE migration_users ADD COLUMN final_mail TEXT CHECK (final_mail IN ('running', 'done'));
ALTER TABLE migration_users ADD COLUMN final_mail_changes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_users ADD COLUMN final_mail_cursor TEXT;     -- Gmail history page token
ALTER TABLE migration_users ADD COLUMN final_drive TEXT CHECK (final_drive IN ('running', 'done'));
ALTER TABLE migration_users ADD COLUMN final_drive_changes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_users ADD COLUMN final_contacts_base INTEGER; -- contacts handled before the final pass

ALTER TABLE migration_drives ADD COLUMN changes_token TEXT;
ALTER TABLE migration_drives ADD COLUMN final_state TEXT CHECK (final_state IN ('running', 'done'));
ALTER TABLE migration_drives ADD COLUMN final_changes INTEGER NOT NULL DEFAULT 0;
