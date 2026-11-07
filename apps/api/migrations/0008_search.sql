-- Storage search (search/): files are turned into passages and embedded into Vectorize, one namespace per
-- organization. D1 stays the source of truth; Vectorize only holds what can be rebuilt from R2.

-- An admin can keep a file out of search. Copied to each new version of a Storage file, so it sticks.
ALTER TABLE files ADD COLUMN search_excluded INTEGER NOT NULL DEFAULT 0;

-- One row per document that has been through indexing: what was written to Vectorize (so it can be deleted by id
-- later) and how it went. doc_id is also the prefix of the document's vector ids (`<doc_id>:<chunk>`).
--   file:<file id>   a Storage version or a mail attachment
--   email:<email id> a mail body (later)
-- No foreign keys on purpose: a row must outlive its file (and its organization) until the vectors are gone. The
-- hourly sweep deletes the vectors of rows whose file no longer exists.
CREATE TABLE search_docs (
  doc_id           TEXT PRIMARY KEY,
  file_id          TEXT,
  item_id          TEXT,                 -- the Storage item, so a new version can drop the old version's vectors
  mailbox_id       TEXT,                 -- attachments and mail
  organization_id  TEXT NOT NULL,        -- the Vectorize namespace
  chunks           INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL CHECK (status IN ('indexed', 'skipped', 'excluded', 'failed')),
  error            TEXT,
  indexed_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX search_docs_file_uniq ON search_docs (file_id) WHERE file_id IS NOT NULL;
CREATE INDEX search_docs_item_idx ON search_docs (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX search_docs_status_idx ON search_docs (status, indexed_at);
