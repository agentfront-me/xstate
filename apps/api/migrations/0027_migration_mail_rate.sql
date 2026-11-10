-- Google Workspace imports: each person's recent mail copy speed (messages a second, smoothed over pages), so the
-- copy screen's time left follows the current speed rather than the average since the start (migration/mail.ts).
ALTER TABLE migration_users ADD COLUMN mail_rate REAL;
