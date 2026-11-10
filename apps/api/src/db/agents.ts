// ai_providers, secrets, agents and agent_versions. See migrations/0023_agents.sql.

export type ProviderStatus = 'valid' | 'invalid' | 'no_credit' | 'rate_limited'

export type ProviderRow = {
  organization_id: string
  provider: 'anthropic' | 'openai'
  key_encrypted: string
  key_last4: string
  status: ProviderStatus
  status_detail: string | null
  models: string
  added_by: string | null
  added_by_name: string | null
  created_at: string
  updated_at: string
  checked_at: string | null
}

export type SecretRow = {
  id: string
  organization_id: string
  name: string
  value_encrypted: string
  created_at: string
  updated_at: string
  last_used_at: string | null
}

export type AgentRow = {
  id: string
  organization_id: string
  name: string
  description: string
  status: 'active' | 'paused'
  draft: string
  published_version: number | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type VersionRow = {
  agent_id: string
  version: number
  config: string
  published_by: string | null
  published_by_name: string | null
  published_at: string
}

// ---------------------------------------------------------------------------------------------------------------
// AI providers

const PROVIDER_SELECT = `SELECT p.*, u.name AS added_by_name FROM ai_providers p LEFT JOIN users u ON u.id = p.added_by`

export async function listProviders(db: D1Database, organizationId: string): Promise<ProviderRow[]> {
  const { results } = await db.prepare(`${PROVIDER_SELECT} WHERE p.organization_id = ? ORDER BY p.provider`).bind(organizationId).all<ProviderRow>()
  return results
}

export function findProvider(db: D1Database, organizationId: string, provider: string): Promise<ProviderRow | null> {
  return db.prepare(`${PROVIDER_SELECT} WHERE p.organization_id = ? AND p.provider = ?`).bind(organizationId, provider).first<ProviderRow>()
}

export function upsertProvider(
  db: D1Database,
  row: { organizationId: string; provider: string; keyEncrypted: string; last4: string; models: string[]; userId: string; now: string },
) {
  return db
    .prepare(
      `INSERT INTO ai_providers (organization_id, provider, key_encrypted, key_last4, status, status_detail, models, added_by, created_at, updated_at, checked_at)
       VALUES (?1, ?2, ?3, ?4, 'valid', NULL, ?5, ?6, ?7, ?7, ?7)
       ON CONFLICT (organization_id, provider) DO UPDATE SET key_encrypted = ?3, key_last4 = ?4, status = 'valid', status_detail = NULL,
         models = ?5, added_by = ?6, updated_at = ?7, checked_at = ?7`,
    )
    .bind(row.organizationId, row.provider, row.keyEncrypted, row.last4, JSON.stringify(row.models), row.userId, row.now)
    .run()
}

export function setProviderStatus(
  db: D1Database,
  organizationId: string,
  provider: string,
  status: ProviderStatus,
  detail: string | null,
  models?: string[],
) {
  const now = new Date().toISOString()
  return models
    ? db
        .prepare('UPDATE ai_providers SET status = ?, status_detail = ?, models = ?, checked_at = ? WHERE organization_id = ? AND provider = ?')
        .bind(status, detail, JSON.stringify(models), now, organizationId, provider)
        .run()
    : db
        .prepare('UPDATE ai_providers SET status = ?, status_detail = ?, checked_at = ? WHERE organization_id = ? AND provider = ?')
        .bind(status, detail, now, organizationId, provider)
        .run()
}

export function deleteProvider(db: D1Database, organizationId: string, provider: string) {
  return db.prepare('DELETE FROM ai_providers WHERE organization_id = ? AND provider = ?').bind(organizationId, provider).run()
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets

export async function listSecrets(db: D1Database, organizationId: string): Promise<SecretRow[]> {
  const { results } = await db.prepare('SELECT * FROM secrets WHERE organization_id = ? ORDER BY name').bind(organizationId).all<SecretRow>()
  return results
}

export function upsertSecret(db: D1Database, row: { id: string; organizationId: string; name: string; valueEncrypted: string; userId: string; now: string }) {
  return db
    .prepare(
      `INSERT INTO secrets (id, organization_id, name, value_encrypted, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT (organization_id, name) DO UPDATE SET value_encrypted = ?4, updated_at = ?6`,
    )
    .bind(row.id, row.organizationId, row.name, row.valueEncrypted, row.userId, row.now)
    .run()
}

export function deleteSecret(db: D1Database, organizationId: string, name: string) {
  return db.prepare('DELETE FROM secrets WHERE organization_id = ? AND name = ?').bind(organizationId, name).run()
}

// ---------------------------------------------------------------------------------------------------------------
// Agents

export async function listAgents(db: D1Database, organizationId: string): Promise<AgentRow[]> {
  const { results } = await db.prepare('SELECT * FROM agents WHERE organization_id = ? ORDER BY created_at').bind(organizationId).all<AgentRow>()
  return results
}

export function findAgent(db: D1Database, agentId: string): Promise<AgentRow | null> {
  return db.prepare('SELECT * FROM agents WHERE id = ?').bind(agentId).first<AgentRow>()
}

export function insertAgent(db: D1Database, row: { id: string; organizationId: string; name: string; description: string; draft: string; userId: string; now: string }) {
  return db
    .prepare(
      `INSERT INTO agents (id, organization_id, name, description, status, draft, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paused', ?, ?, ?, ?)`,
    )
    .bind(row.id, row.organizationId, row.name, row.description, row.draft, row.userId, row.now, row.now)
}

export function updateAgent(db: D1Database, agentId: string, fields: { name?: string; description?: string; draft?: string; status?: string }) {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [column, value] of Object.entries(fields)) {
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    values.push(value)
  }
  sets.push('updated_at = ?')
  values.push(new Date().toISOString())
  return db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).bind(...values, agentId)
}

export function deleteAgent(db: D1Database, agentId: string) {
  return db.prepare('DELETE FROM agents WHERE id = ?').bind(agentId).run()
}

/** Publishes the draft as the next version, in one batch so two publishes can't take the same number. */
export async function publish(db: D1Database, agentId: string, userId: string, now: string): Promise<number> {
  const [, , row] = await db.batch([
    db
      .prepare(
        `INSERT INTO agent_versions (agent_id, version, config, published_by, published_at)
         SELECT id, coalesce(published_version, 0) + 1, draft, ?, ? FROM agents WHERE id = ?`,
      )
      .bind(userId, now, agentId),
    db.prepare('UPDATE agents SET published_version = coalesce(published_version, 0) + 1, updated_at = ? WHERE id = ?').bind(now, agentId),
    db.prepare('SELECT published_version FROM agents WHERE id = ?').bind(agentId),
  ])
  return (row!.results[0] as { published_version: number }).published_version
}

const VERSION_SELECT = `SELECT v.*, u.name AS published_by_name FROM agent_versions v LEFT JOIN users u ON u.id = v.published_by`

export function findVersion(db: D1Database, agentId: string, version: number): Promise<VersionRow | null> {
  return db.prepare(`${VERSION_SELECT} WHERE v.agent_id = ? AND v.version = ?`).bind(agentId, version).first<VersionRow>()
}

export async function listVersions(db: D1Database, agentId: string): Promise<VersionRow[]> {
  const { results } = await db.prepare(`${VERSION_SELECT} WHERE v.agent_id = ? ORDER BY v.version DESC LIMIT 50`).bind(agentId).all<VersionRow>()
  return results
}
