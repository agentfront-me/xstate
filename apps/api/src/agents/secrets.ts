// Settings → Secrets: organization values used in connector headers (Phase 4). Owners and admins only. A value can't
// be read back through the API; it's decrypted only when a connector request is made, outside the model's context.

import type { Actor } from '../auth/types'
import * as db from '../db/agents'
import { ApiError } from '../errors'
import { requireAdmin } from './providers'
import { seal } from './seal'

export type Secret = { name: string; createdAt: string; updatedAt: string; lastUsedAt: string | null; usedBy: string[] }

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const MAX_VALUE = 8_000

export async function list(env: Env, actor: Actor, organizationId: string): Promise<Secret[]> {
  await requireAdmin(env, actor, organizationId)
  // Where each one is used: the connectors whose headers refer to it.
  const { results } = await env.DB.prepare('SELECT name, secret_refs FROM connectors WHERE organization_id = ?')
    .bind(organizationId)
    .all<{ name: string; secret_refs: string }>()
  const usedBy = (secret: string) => results.filter((c) => (JSON.parse(c.secret_refs) as string[]).includes(secret)).map((c) => c.name)
  return (await db.listSecrets(env.DB, organizationId)).map((s) => ({
    name: s.name,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    lastUsedAt: s.last_used_at,
    usedBy: usedBy(s.name),
  }))
}

export async function save(env: Env, actor: Actor, organizationId: string, name: string, value: string): Promise<Secret[]> {
  await requireAdmin(env, actor, organizationId)
  if (!SECRET_NAME.test(name)) throw new ApiError('invalid_name', 'Names use capital letters, digits and underscores, and start with a letter')
  if (!value) throw new ApiError('invalid_value', 'Enter a value')
  if (value.length > MAX_VALUE) throw new ApiError('invalid_value', `Values can be up to ${MAX_VALUE} characters`)
  await db.upsertSecret(env.DB, {
    id: crypto.randomUUID(),
    organizationId,
    name,
    valueEncrypted: await seal(env, value),
    userId: actor.userId,
    now: new Date().toISOString(),
  })
  return list(env, actor, organizationId)
}

export async function remove(env: Env, actor: Actor, organizationId: string, name: string): Promise<void> {
  await requireAdmin(env, actor, organizationId)
  await db.deleteSecret(env.DB, organizationId, name)
}
