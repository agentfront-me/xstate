-- Member invitations. An invite creates the members row straight away (and a users row with no password for
-- someone new to xstate), so mailboxes, shares and imports can point at the member before they accept. Until they
-- accept, the membership is 'invited': it doesn't count for sign-in or access checks (db/members.ts find).

ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active'));

-- One open invitation per invited member. Deleted when it's accepted, or with the member.
CREATE TABLE invitations (
  member_id        TEXT PRIMARY KEY REFERENCES members (id) ON DELETE CASCADE,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- SHA-256 (hex) of the token in the link. The token itself is never stored. Sending again makes a new one.
  token_hash       TEXT NOT NULL UNIQUE,
  invited_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
  -- When the invite email last went out. NULL: created but not sent yet (a migration sends them at the end).
  sent_at          TEXT,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX invitations_org_idx ON invitations (organization_id);
