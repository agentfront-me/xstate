-- The organization's two API keys (audience/keys.ts). Created the first time an admin opens Settings → API keys, or
-- the first time the organization calls an endpoint that needs them.
--   Publishable key (pk_live_…): safe in browsers. The tracking snippet sends it with every event. Stored as is.
--   Secret key (sk_live_…): server only. Signs identify() calls (user hash) and authenticates server-to-server calls;
--   later also sending email. Looked up by its SHA-256 hash; also kept encrypted (AES-GCM under
--   API_KEYS_ENCRYPTION_KEY) because the dashboard can reveal it and identify() hashes are checked with it.
CREATE TABLE api_keys (
  organization_id      TEXT PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  publishable_key      TEXT NOT NULL UNIQUE,
  secret_hash          TEXT NOT NULL UNIQUE,   -- hex SHA-256 of the secret key
  secret_encrypted     TEXT NOT NULL,          -- base64 of iv (12 bytes) + AES-GCM ciphertext
  secret_last4         TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  secret_rolled_at     TEXT NOT NULL,
  secret_last_used_at  TEXT
);
