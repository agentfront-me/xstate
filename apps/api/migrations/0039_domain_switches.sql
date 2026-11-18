-- Moving a domain's mail from Stalwart to the mailbox store (docs/mailbox-store-plan.md, phase 4d): one row per
-- attempt. `steps` is a JSON list of the flip's steps with their time and outcome, so a flip that stopped can be
-- resumed and support can see where it stopped. domains.mail_path stays what the rest of the code reads.
CREATE TABLE domain_switches (
  id          TEXT PRIMARY KEY,
  domain_id   TEXT NOT NULL REFERENCES domains (id) ON DELETE CASCADE,
  state       TEXT NOT NULL CHECK (state IN ('switching', 'flipped', 'rolled_back', 'cancelled')),
  started_at  TEXT NOT NULL,
  started_by  TEXT,
  mx_seen_at  TEXT,
  flipped_at  TEXT,
  ended_at    TEXT,
  steps       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX domain_switches_domain ON domain_switches (domain_id, started_at);
