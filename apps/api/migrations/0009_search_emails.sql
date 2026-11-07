-- Search over email bodies (search/). Mail sync indexes message text as `email:<mailbox id>:<message id>` documents
-- in search_docs; bodies_synced records that a mailbox's existing messages were queued once, so mailboxes synced
-- before search existed are backfilled on their next hourly sync.
ALTER TABLE mailbox_sync ADD COLUMN bodies_synced INTEGER NOT NULL DEFAULT 0;

-- A mailbox's documents (emails and attachments), for the sweep after it is deleted.
CREATE INDEX search_docs_mailbox_idx ON search_docs (mailbox_id) WHERE mailbox_id IS NOT NULL;
