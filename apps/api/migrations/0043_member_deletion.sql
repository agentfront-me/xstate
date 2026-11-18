-- Deleting a member, restorable for 30 days (docs/members-plan.md, phase 4). While delete_after is set the member is
-- also suspended (suspended_at); the hourly job finishes the deletion once delete_after has passed.
ALTER TABLE members ADD COLUMN delete_after TEXT;
-- What happens to their mailbox then: 'shared' (it becomes a shared mailbox) or 'delete' (it and its mail go).
ALTER TABLE members ADD COLUMN delete_mail TEXT CHECK (delete_mail IN ('shared', 'delete'));
-- The members given access to their mailbox when it's turned into a shared one (JSON array), so restoring can take
-- that access away again.
ALTER TABLE members ADD COLUMN delete_shared_with TEXT;
-- Who deleted them (a member id): their files and agents go to this person.
ALTER TABLE members ADD COLUMN deleted_by TEXT;
CREATE INDEX members_delete_after_idx ON members (delete_after) WHERE delete_after IS NOT NULL;
