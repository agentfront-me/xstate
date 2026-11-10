-- Push notifications to the mobile app (push/). One row per installed app: its Expo push token, whose phone it is,
-- and the Settings switches, kept here so the server decides what to send.
CREATE TABLE devices (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token                TEXT NOT NULL UNIQUE,            -- "ExponentPushToken[...]"; moves with the phone to whoever signs in
  platform             TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  notify_email         INTEGER NOT NULL DEFAULT 1,      -- new mail in a mailbox the user can open
  notify_approvals     INTEGER NOT NULL DEFAULT 1,      -- an agent is waiting for the user's OK
  notify_agent_errors  INTEGER NOT NULL DEFAULT 1,      -- a run failed (a rejected key fails the run)
  domain_id            TEXT REFERENCES domains (id) ON DELETE SET NULL,  -- new mail on this domain only; NULL is all
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX devices_user ON devices (user_id);

-- Small facts the sender keeps between jobs: where each mailbox's new-mail check got to ("mail:<mailbox id>", a JMAP
-- state) and when an agent's failure was last pushed ("agent-error:<agent id>", so a failing agent isn't a flood).
CREATE TABLE push_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
