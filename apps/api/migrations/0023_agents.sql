-- Agents, Phase 1 (docs/agents-plan.md). Customers bring their own AI keys; agents are configured in the app.
-- Runs, run steps and usage live in each agent's Durable Object (agents/store.ts), not here.

-- The organization's AI provider keys (agents/providers.ts). One per provider. The key is encrypted with AES-GCM under
-- API_KEYS_ENCRYPTION_KEY (agents/seal.ts) and never returned by the API; the dashboard shows the last 4 characters.
CREATE TABLE ai_providers (
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  key_encrypted    TEXT NOT NULL,
  key_last4        TEXT NOT NULL,
  -- From the last check or the last run that failed because of the key: valid, invalid, no_credit, rate_limited.
  status           TEXT NOT NULL DEFAULT 'valid',
  status_detail    TEXT,
  models           TEXT NOT NULL DEFAULT '[]',   -- JSON array of model ids the key can use, from the last check
  added_by         TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  checked_at       TEXT,
  PRIMARY KEY (organization_id, provider)
);

-- Organization secrets (agents/secrets.ts): values used in connector headers, never shown again and never given to
-- a model. Encrypted like AI keys.
CREATE TABLE secrets (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,                -- A-Z, 0-9 and _, starting with a letter
  value_encrypted  TEXT NOT NULL,
  created_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_used_at     TEXT,
  UNIQUE (organization_id, name)
);

-- An agent and its draft config (agents/config.ts, JSON). Publishing copies the draft into agent_versions; runs use
-- the published version, tests can use the draft.
CREATE TABLE agents (
  id                 TEXT PRIMARY KEY,
  organization_id    TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('active', 'paused')),
  draft              TEXT NOT NULL,
  published_version  INTEGER,                      -- NULL until the first publish
  created_by         TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX agents_org ON agents (organization_id, created_at);

-- Every published config, kept for version history and so a run can say which version it used. Published runs act
-- with the access of the person who published that version (published_by).
CREATE TABLE agent_versions (
  agent_id      TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  config        TEXT NOT NULL,
  published_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
  published_at  TEXT NOT NULL,
  PRIMARY KEY (agent_id, version)
);
