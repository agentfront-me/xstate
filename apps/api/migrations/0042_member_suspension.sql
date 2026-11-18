-- Signing a member out everywhere, and suspending them (docs/members-plan.md, phase 3).

-- Session tokens issued before this time are refused (auth/token.ts). Set by "Sign out everywhere", suspending,
-- a new temporary password and a password reset.
ALTER TABLE users ADD COLUMN sessions_after TEXT;

-- Set while the member is suspended: they can't sign in to the organization or reach anything in it, and nobody is
-- notified on their behalf. Their mailbox keeps receiving mail. A column rather than a new members.status value, so
-- the members table (which many tables reference) doesn't have to be rebuilt.
ALTER TABLE members ADD COLUMN suspended_at TEXT;
