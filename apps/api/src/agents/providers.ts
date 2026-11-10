// Settings → AI providers: the organization's own Anthropic and OpenAI keys. Owners and admins only.
// Saving a key checks it first by listing the provider's models (free, no tokens); the list is kept so agents can
// only pick models the key can use. Runs report key failures back here (reportFailure), so the card shows why.

import type { Actor } from '../auth/types'
import * as db from '../db/agents'
import type { ProviderRow, ProviderStatus } from '../db/agents'
import { ApiError } from '../errors'
import { isAdmin, loadMember } from '../mailserver/access'
import { PROVIDERS, parseConfig, type ProviderId } from './config'
import { seal, unseal } from './seal'

export type Provider = {
  provider: ProviderId
  last4: string
  status: ProviderStatus
  statusDetail: string | null
  models: string[]
  addedBy: string | null
  createdAt: string
  updatedAt: string
  checkedAt: string | null
  /** Agents whose draft or published config uses this provider. */
  usedBy: number
}

export async function requireAdmin(env: Env, actor: Actor, organizationId: string) {
  const member = await loadMember(env, organizationId, actor.userId)
  if (!isAdmin(member)) throw new ApiError('forbidden', 'Only owners and admins can manage AI providers and secrets', 403)
  return member
}

function present(row: ProviderRow, usedBy: number): Provider {
  return {
    provider: row.provider,
    last4: row.key_last4,
    status: row.status,
    statusDetail: row.status_detail,
    models: JSON.parse(row.models) as string[],
    addedBy: row.added_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    checkedAt: row.checked_at,
    usedBy,
  }
}

async function usage(env: Env, organizationId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const agent of await db.listAgents(env.DB, organizationId)) {
    const provider = parseConfig(agent.draft).model?.provider
    if (provider) counts[provider] = (counts[provider] ?? 0) + 1
  }
  return counts
}

export async function list(env: Env, actor: Actor, organizationId: string): Promise<Provider[]> {
  await requireAdmin(env, actor, organizationId)
  const counts = await usage(env, organizationId)
  return (await db.listProviders(env.DB, organizationId)).map((row) => present(row, counts[row.provider] ?? 0))
}

/** Checks and saves a key, replacing the provider's current one. */
export async function save(env: Env, actor: Actor, organizationId: string, provider: ProviderId, apiKey: string): Promise<Provider> {
  await requireAdmin(env, actor, organizationId)
  const key = apiKey.trim()
  const check = await checkKey(provider, key)
  if (check.status !== 'valid') throw new ApiError('key_rejected', check.detail ?? 'The provider rejected this key', 400, { status: check.status })
  const now = new Date().toISOString()
  await db.upsertProvider(env.DB, {
    organizationId,
    provider,
    keyEncrypted: await seal(env, key),
    last4: key.slice(-4),
    models: check.models,
    userId: actor.userId,
    now,
  })
  const counts = await usage(env, organizationId)
  return present((await db.findProvider(env.DB, organizationId, provider))!, counts[provider] ?? 0)
}

/** Checks the saved key again and refreshes its model list. */
export async function recheck(env: Env, actor: Actor, organizationId: string, provider: ProviderId): Promise<Provider> {
  await requireAdmin(env, actor, organizationId)
  const row = await db.findProvider(env.DB, organizationId, provider)
  if (!row) throw new ApiError('not_found', 'No key for this provider', 404)
  const check = await checkKey(provider, await unseal(env, row.key_encrypted))
  await db.setProviderStatus(env.DB, organizationId, provider, check.status, check.detail, check.status === 'valid' ? check.models : undefined)
  const counts = await usage(env, organizationId)
  return present((await db.findProvider(env.DB, organizationId, provider))!, counts[provider] ?? 0)
}

export async function remove(env: Env, actor: Actor, organizationId: string, provider: ProviderId): Promise<void> {
  await requireAdmin(env, actor, organizationId)
  await db.deleteProvider(env.DB, organizationId, provider)
}

// ---------------------------------------------------------------------------------------------------------------
// For runs

/** The decrypted key for a run, or why there isn't a usable one. Never leaves the Worker. */
export async function keyFor(env: Env, organizationId: string, provider: ProviderId): Promise<{ key: string } | { error: string }> {
  const row = await db.findProvider(env.DB, organizationId, provider)
  if (!row) return { error: `No ${label(provider)} key. Add one in Settings → AI providers.` }
  if (row.status === 'invalid') return { error: `${label(provider)} rejected the key. Update it in Settings → AI providers.` }
  return { key: await unseal(env, row.key_encrypted) }
}

/** Records a key failure a run ran into, so Settings and the agent show it. */
export async function reportFailure(env: Env, organizationId: string, provider: ProviderId, status: ProviderStatus, detail: string) {
  await db.setProviderStatus(env.DB, organizationId, provider, status, detail)
}

/** A run succeeded with the key: clear a temporary status (rate limited, out of credit) if one was set. */
export async function reportSuccess(env: Env, organizationId: string, provider: ProviderId) {
  await env.DB.prepare(
    "UPDATE ai_providers SET status = 'valid', status_detail = NULL WHERE organization_id = ? AND provider = ? AND status IN ('rate_limited', 'no_credit')",
  )
    .bind(organizationId, provider)
    .run()
}

export const label = (provider: ProviderId) => (provider === 'anthropic' ? 'Anthropic' : 'OpenAI')

// ---------------------------------------------------------------------------------------------------------------
// Talking to the providers

type Check = { status: ProviderStatus; detail: string | null; models: string[] }

/** Sorts a provider's HTTP error into a key status. Shared with runs, which see the same errors. */
export function classify(provider: ProviderId, status: number, body: string): { status: ProviderStatus; detail: string } {
  const text = body.toLowerCase()
  if (status === 401 || status === 403) return { status: 'invalid', detail: `${label(provider)} rejected the key (${status}).` }
  if (status === 402 || text.includes('insufficient_quota') || text.includes('credit balance') || text.includes('billing')) {
    return { status: 'no_credit', detail: `${label(provider)} says the account is out of credit. Add credit with ${label(provider)}.` }
  }
  if (status === 429) return { status: 'rate_limited', detail: `${label(provider)} is rate limiting this key. Runs are slowed down.` }
  return { status: 'valid', detail: `${label(provider)} answered ${status}.` }
}

/** OpenAI lists every model the key can reach, including audio, image and embedding ones; agents need chat models. */
const OPENAI_CHAT = /^(gpt-|o\d)/
const OPENAI_NOT_CHAT = /(audio|realtime|tts|transcribe|image|embedding|search|moderation|instruct|codex)/

async function checkKey(provider: ProviderId, key: string): Promise<Check> {
  if (!PROVIDERS.includes(provider)) throw new ApiError('invalid_input', 'Unknown provider')
  if (key.length < 20 || key.length > 400 || /\s/.test(key)) return { status: 'invalid', detail: "That doesn't look like an API key.", models: [] }
  if (provider === 'anthropic' && !key.startsWith('sk-ant-')) {
    return { status: 'invalid', detail: 'Anthropic API keys start with sk-ant-. Create one at console.anthropic.com.', models: [] }
  }
  let res: Response
  try {
    res =
      provider === 'anthropic'
        ? await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } })
        : await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } })
  } catch {
    throw new ApiError('provider_unreachable', `Couldn't reach ${label(provider)}. Try again.`, 502)
  }
  if (!res.ok) {
    const failure = classify(provider, res.status, await res.text())
    if (failure.status === 'valid') throw new ApiError('provider_error', failure.detail, 502)
    return { ...failure, models: [] }
  }
  const data = (await res.json()) as { data?: { id: string }[] }
  let models = (data.data ?? []).map((m) => m.id)
  if (provider === 'openai') models = models.filter((id) => OPENAI_CHAT.test(id) && !OPENAI_NOT_CHAT.test(id) && !/-\d{4}-\d{2}-\d{2}$/.test(id))
  return { status: 'valid', detail: null, models: models.sort() }
}
