-- Agents, Phase 4 (docs/agents-plan.md): connectors. Any MCP server by URL, added once per organization and shared by
-- its agents. Credentials live here, encrypted (agents/seal.ts), never in an agent's own storage: header values may
-- reference organization secrets ({{secret.NAME}}), filled in when a call is made; OAuth tokens are kept per
-- connector and refreshed by the MCP client.
CREATE TABLE connectors (
  id                 TEXT PRIMARY KEY,
  organization_id    TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  url                TEXT NOT NULL,
  auth               TEXT NOT NULL CHECK (auth IN ('none', 'headers', 'oauth')),
  headers_encrypted  TEXT,                  -- JSON [{ name, value }], values may contain {{secret.NAME}}
  header_names       TEXT NOT NULL DEFAULT '[]',
  secret_refs        TEXT NOT NULL DEFAULT '[]',  -- secret names the headers use, for Settings → Secrets "used by"
  oauth_encrypted    TEXT,                  -- JSON: client registration, tokens, PKCE verifier, pending state
  status             TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'needs_auth', 'error')),
  status_detail      TEXT,
  tools              TEXT NOT NULL DEFAULT '[]',  -- JSON tool list from the last discovery
  created_by         TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  checked_at         TEXT
);
CREATE INDEX connectors_org ON connectors (organization_id, created_at);
