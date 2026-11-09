-- Copying Google Drive into Storage (src/migration/drive.ts): each person's My Drive into their My Files, and each
-- ticked shared drive into a team folder. Which items were copied is in the MigrationStore.

ALTER TABLE migration_users ADD COLUMN drive_state TEXT CHECK (drive_state IN ('copying', 'done', 'attention'));
ALTER TABLE migration_users ADD COLUMN drive_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_users ADD COLUMN drive_copied_bytes INTEGER NOT NULL DEFAULT 0;
-- {"phase": "folders" | "files", "token": "<page token>" | null}
ALTER TABLE migration_users ADD COLUMN drive_cursor TEXT;
ALTER TABLE migration_users ADD COLUMN drive_chain INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_users ADD COLUMN drive_note TEXT;
-- For someone with no member (imported as a shared mailbox): the team folder their Drive goes in.
ALTER TABLE migration_users ADD COLUMN drive_root TEXT;

-- Ticked shared drives, created at Start.
CREATE TABLE migration_drives (
  migration_id     TEXT NOT NULL REFERENCES migrations (id) ON DELETE CASCADE,
  drive_id         TEXT NOT NULL,
  name             TEXT NOT NULL,
  folder_id        TEXT,                -- the team folder in the organization space
  state            TEXT CHECK (state IN ('copying', 'done', 'attention')),
  done             INTEGER NOT NULL DEFAULT 0,
  bytes            INTEGER NOT NULL DEFAULT 0,
  cursor           TEXT,
  chain            INTEGER NOT NULL DEFAULT 0,
  note             TEXT,
  PRIMARY KEY (migration_id, drive_id)
);
