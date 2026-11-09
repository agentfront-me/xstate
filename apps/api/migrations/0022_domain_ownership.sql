-- Proving a domain is the organization's without moving its mail: a TXT record "xstate-verification=<token>" at the
-- domain's apex. A Google Workspace import needs it (migration/service.ts) before the switch moves MX to xstate,
-- which is what `status = 'verified'` means. See mailserver/domains.ts (ownershipRecord, checkOwnership).
ALTER TABLE domains ADD COLUMN ownership_token TEXT;
-- When the TXT record was found (or the mail records, which prove the same).
ALTER TABLE domains ADD COLUMN owned_at TEXT;
UPDATE domains SET ownership_token = lower(hex(randomblob(16))) WHERE ownership_token IS NULL;
UPDATE domains SET owned_at = verified_at WHERE status = 'verified' AND owned_at IS NULL;
