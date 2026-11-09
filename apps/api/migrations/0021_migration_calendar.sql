-- Copying Google Calendar (src/migration/calendar.ts) into each person's xstate mailbox calendar. Which events were
-- copied, and what they became, is in the MigrationStore (kind 'event'; 'calendar' for the calendars made); these
-- are the plan flag and progress counters.

-- 0 for migrations planned before calendars could be copied: nothing changes for them unless the admin ticks it.
ALTER TABLE migration_users ADD COLUMN copy_calendar INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_users ADD COLUMN calendar_state TEXT CHECK (calendar_state IN ('copying', 'done', 'attention'));
ALTER TABLE migration_users ADD COLUMN calendar_done INTEGER NOT NULL DEFAULT 0;
-- JSON: the person's calendars ({id, name, primary, timeZone, target, syncToken}) and where the copy is
-- ({index, phase: 'events' | 'occurrences', pageToken}). The sync tokens are what the final pass starts from.
ALTER TABLE migration_users ADD COLUMN calendar_cursor TEXT;
ALTER TABLE migration_users ADD COLUMN calendar_chain INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_users ADD COLUMN calendar_note TEXT;
-- The final pass: Google's changes since the copy, through each calendar's sync token.
ALTER TABLE migration_users ADD COLUMN final_calendar TEXT CHECK (final_calendar IN ('running', 'done'));
ALTER TABLE migration_users ADD COLUMN final_calendar_changes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_users ADD COLUMN final_calendar_cursor TEXT;
