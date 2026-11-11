-- Google Workspace imports: how many times a person's mail copy was started again after its job ran out of queue
-- retries while it was still working past messages that kill the Worker (migration/jobs.ts consumeMigrationDead).
-- Capped, so a mailbox that can't be copied still ends up needing attention. Reset when an admin presses Retry.
ALTER TABLE migration_users ADD COLUMN mail_revivals INTEGER NOT NULL DEFAULT 0;
