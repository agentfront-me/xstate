-- The hourly purge looks for files deleted more than 30 days ago (storage/purge.ts).
CREATE INDEX files_purge_idx ON files (deleted_at) WHERE status = 'deleted';
