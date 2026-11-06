-- Storage: folders and files people keep in the organization's R2 bucket, next to the mail attachments.
--
-- The tree lives here; R2 only holds the bytes. Folders exist only as rows, so renaming or moving anything is one
-- update and never copies objects. Each saved version of a file is its own `files` row and R2 object:
--   <bucket>/drive/<item id>/<file id>/<file name>
-- Mail attachments keep their keys under <mailbox id>/ and are shown as the read-only "Mail Attachments" folder,
-- with access decided by the mailbox (mailserver/access.ts), not by the grants below.

PRAGMA defer_foreign_keys = on;

-- files: add source 'drive' and link versions to their item. SQLite can't change a CHECK, so the table is rebuilt.
CREATE TABLE files_new (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mailbox_id        TEXT,                     -- NULL for Storage files
  r2_key            TEXT NOT NULL,
  name              TEXT NOT NULL,
  content_type      TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  sha256            TEXT,
  source            TEXT NOT NULL CHECK (source IN ('received', 'sent', 'upload', 'drive')),
  status            TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('pending', 'ready', 'deleted')),
  email_id          TEXT,
  thread_id         TEXT,
  part_id           TEXT,
  stalwart_blob_id  TEXT,
  disposition       TEXT CHECK (disposition IN ('attachment', 'inline')),
  content_id        TEXT,
  -- Storage files: the item this is a version of, and which version. No foreign key on purpose: when an item is
  -- deleted, the trigger below marks its versions deleted so the purge removes their R2 objects.
  item_id           TEXT,
  version           INTEGER,
  created_by        TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  deleted_at        TEXT,
  FOREIGN KEY (mailbox_id, organization_id) REFERENCES mailboxes (id, organization_id) ON DELETE CASCADE
);
INSERT INTO files_new (id, organization_id, mailbox_id, r2_key, name, content_type, size_bytes, sha256, source, status,
  email_id, thread_id, part_id, stalwart_blob_id, disposition, content_id, created_by, created_at, deleted_at)
SELECT id, organization_id, mailbox_id, r2_key, name, content_type, size_bytes, sha256, source, status,
  email_id, thread_id, part_id, stalwart_blob_id, disposition, content_id, created_by, created_at, deleted_at
FROM files;
DROP TABLE files;
ALTER TABLE files_new RENAME TO files;

CREATE UNIQUE INDEX files_part_uniq ON files (mailbox_id, email_id, part_id) WHERE email_id IS NOT NULL;
CREATE INDEX files_mailbox_idx ON files (mailbox_id, created_at);
CREATE INDEX files_email_idx ON files (mailbox_id, email_id);
CREATE INDEX files_org_idx ON files (organization_id);
CREATE INDEX files_purge_idx ON files (deleted_at) WHERE status = 'deleted';
CREATE UNIQUE INDEX files_item_version_uniq ON files (item_id, version) WHERE item_id IS NOT NULL;

-- The folder and file tree.
--   space 'personal':     "My Files". Top-level items belong to their owner; only people they share with see them.
--   space 'organization': team folders. Any member can create one; admins manage all of them.
-- Access only adds up going down the tree: what you have on a folder you have on everything inside it.
CREATE TABLE storage_items (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  space            TEXT NOT NULL CHECK (space IN ('personal', 'organization')),
  parent_id        TEXT REFERENCES storage_items (id) ON DELETE CASCADE,  -- NULL at the top of the space
  kind             TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
  name             TEXT NOT NULL,
  -- Who made it; manages it and everything inside it. NULL once that member has left (org space only: a
  -- leaving member's own top-level personal items are deleted, see the trigger below).
  owner_member_id  TEXT REFERENCES members (id) ON DELETE SET NULL,
  -- What everyone in the organization gets: NULL (only owner and grants), 'viewer' or 'editor'.
  org_access       TEXT CHECK (org_access IN ('viewer', 'editor')),
  -- Files: the current version's files row, its number, size and type. Folders: NULL / 0.
  file_id          TEXT,
  version          INTEGER NOT NULL DEFAULT 0,
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  content_type     TEXT,
  created_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at       TEXT NOT NULL,
  -- In the trash since then. Everything inside a trashed folder is treated as trashed too. Emptied after 30 days.
  trashed_at       TEXT,
  trashed_by       TEXT REFERENCES users (id) ON DELETE SET NULL
);
-- No two live items with the same name (ignoring case) in one folder, or at the top of one person's My Files or of
-- the organization space.
CREATE UNIQUE INDEX storage_items_name_uniq ON storage_items (
  organization_id,
  IFNULL(parent_id, CASE WHEN space = 'personal' THEN 'p:' || IFNULL(owner_member_id, '') ELSE 'o' END),
  name COLLATE NOCASE
) WHERE trashed_at IS NULL;
CREATE INDEX storage_items_parent_idx ON storage_items (parent_id);
CREATE INDEX storage_items_top_idx ON storage_items (organization_id, space, owner_member_id) WHERE parent_id IS NULL;
CREATE INDEX storage_items_trash_idx ON storage_items (trashed_at) WHERE trashed_at IS NOT NULL;

-- Access given to one member on an item (and so on everything inside it).
CREATE TABLE storage_grants (
  item_id     TEXT NOT NULL REFERENCES storage_items (id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'manager')),
  created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (item_id, member_id)
);
CREATE INDEX storage_grants_member_idx ON storage_grants (member_id);

-- A deleted item's versions are marked deleted (also for items removed by a cascade: a parent folder, a member or
-- the organization). The hourly purge then removes their R2 objects. The epoch date skips the 30-day grace: items
-- reach here only after their 30 days in the trash, or because their owner or organization is gone.
CREATE TRIGGER storage_items_delete_files AFTER DELETE ON storage_items
BEGIN
  UPDATE files SET status = 'deleted', deleted_at = '1970-01-01T00:00:00.000Z' WHERE item_id = OLD.id;
END;

-- A member who leaves takes their own My Files with them. Runs before the members row goes, so before
-- owner_member_id is set to NULL.
CREATE TRIGGER members_delete_personal_storage BEFORE DELETE ON members
BEGIN
  DELETE FROM storage_items WHERE owner_member_id = OLD.id AND space = 'personal' AND parent_id IS NULL;
END;
