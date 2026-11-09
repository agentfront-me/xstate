-- Hardening of Google Workspace imports (src/migration/watchdog.ts).

-- What each part looked like at the last hourly check; unchanged an hour later means its job chain was lost.
ALTER TABLE migrations ADD COLUMN watch TEXT;
ALTER TABLE migration_users ADD COLUMN watch TEXT;
ALTER TABLE migration_drives ADD COLUMN watch TEXT;

ALTER TABLE migrations ADD COLUMN copied_notified_at TEXT;  -- the "copy is ready, switch when you like" email went out
ALTER TABLE migrations ADD COLUMN store_cleared_at TEXT;    -- the MigrationStore (id map, skipped items) was deleted
