-- Members with a mailbox (docs/members-plan.md, phase 1). A member added with a mailbox signs in with its primary
-- address; recovery_email is where their invite and password reset links go, since they can't read that mailbox
-- before they've signed in.
ALTER TABLE users ADD COLUMN recovery_email TEXT;

-- Set when an admin chose their password (a temporary one). Signing in then only lets them choose a new one.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
