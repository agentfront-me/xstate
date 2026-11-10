-- Agents, Phase 2 (docs/agents-plan.md): what starts a run. Triggers aren't part of the versioned config: a webhook
-- URL has to stay the same across publishes, and turning a trigger off should take effect at once. They only fire
-- while the agent is on and has a published version; runs use that published version.
CREATE TABLE agent_triggers (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('webhook', 'schedule', 'email')),
  enabled           INTEGER NOT NULL DEFAULT 1,
  config            TEXT NOT NULL,                -- JSON, per kind (agents/triggers.ts)
  -- Webhook: the signing secret, AES-GCM under API_KEYS_ENCRYPTION_KEY (agents/seal.ts).
  secret_encrypted  TEXT,
  -- Email: the mailbox's JMAP Email state the trigger has looked at, so each new message fires once.
  cursor            TEXT,
  -- Email: the mailbox it watches, for finding the triggers of a mailbox that got mail.
  mailbox_id        TEXT REFERENCES mailboxes (id) ON DELETE CASCADE,
  next_run_at       TEXT,                         -- schedule: when it fires next (UTC ISO), NULL when done
  last_fired_at     TEXT,
  created_by        TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX agent_triggers_agent ON agent_triggers (agent_id, created_at);
CREATE INDEX agent_triggers_mailbox ON agent_triggers (mailbox_id) WHERE mailbox_id IS NOT NULL;
