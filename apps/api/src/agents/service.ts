// Agents: create, edit the draft, publish, pause, duplicate, delete, version history, and runs.
// Owners, admins and members with the agents.manage permission can manage agents.
//
// Who a run acts as: a test of the draft acts as the person testing it; a run of the published version acts as the
// person who published that version (their access is checked again on every tool call, so removing them from the
// organization stops the agent's tools).

import { getAgentByName } from 'agents'
import type { Actor } from '../auth/types'
import * as db from '../db/agents'
import type { AgentRow } from '../db/agents'
import { ApiError } from '../errors'
import { isAdmin, loadMember } from '../mailserver/access'
import { agentConfig, defaultConfig, parseConfig, type AgentConfig } from './config'
import { label } from './providers'
import type { AgentStore, RunRow, StepRow } from './store'
import { builtinCatalog } from './tools'

export type AgentSummary = {
  id: string
  name: string
  description: string
  status: 'active' | 'paused'
  publishedVersion: number | null
  hasDraftChanges: boolean
  model: AgentConfig['model']
  createdAt: string
  updatedAt: string
}

export type AgentDetail = AgentSummary & { draft: AgentConfig; published: AgentConfig | null }

const notFound = () => new ApiError('not_found', 'No such agent', 404)

async function requireManager(env: Env, actor: Actor, organizationId: string) {
  const member = await loadMember(env, organizationId, actor.userId)
  if (!isAdmin(member) && !member.permissions.org.includes('agents.manage')) {
    throw new ApiError('forbidden', 'Only owners, admins and people with the agents permission can manage agents', 403)
  }
  return member
}

async function agentContext(env: Env, actor: Actor, agentId: string): Promise<AgentRow> {
  const agent = await db.findAgent(env.DB, agentId)
  if (!agent) throw notFound()
  try {
    await requireManager(env, actor, agent.organization_id)
  } catch (err) {
    // Same answer as a missing agent for people outside the organization.
    if (err instanceof ApiError && err.status === 404) throw notFound()
    throw err
  }
  return agent
}

async function publishedConfig(env: Env, agent: AgentRow) {
  if (agent.published_version === null) return null
  const version = await db.findVersion(env.DB, agent.id, agent.published_version)
  return version ? { config: parseConfig(version.config), raw: version.config, publishedBy: version.published_by } : null
}

const sameConfig = (a: string, b: string | undefined) => !!b && JSON.stringify(parseConfig(a)) === JSON.stringify(parseConfig(b))

async function detail(env: Env, agent: AgentRow): Promise<AgentDetail> {
  const published = await publishedConfig(env, agent)
  const draft = parseConfig(agent.draft)
  return {
    ...summary(agent, published?.raw),
    draft,
    published: published?.config ?? null,
  }
}

function summary(agent: AgentRow, publishedRaw: string | undefined): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    status: agent.status,
    publishedVersion: agent.published_version,
    hasDraftChanges: !sameConfig(agent.draft, publishedRaw),
    model: parseConfig(agent.draft).model,
    createdAt: agent.created_at,
    updatedAt: agent.updated_at,
  }
}

const store = (env: Env, agentId: string) => getAgentByName<Env, AgentStore>(env.AGENT_STORE, agentId)

// ---------------------------------------------------------------------------------------------------------------
// Agents

export async function list(env: Env, actor: Actor, organizationId: string): Promise<AgentSummary[]> {
  await requireManager(env, actor, organizationId)
  const agents = await db.listAgents(env.DB, organizationId)
  return Promise.all(agents.map(async (a) => summary(a, (await publishedConfig(env, a))?.raw)))
}

const name = (s: string) => {
  const n = s.trim()
  if (!n || n.length > 80) throw new ApiError('invalid_name', 'Give the agent a name of up to 80 characters')
  return n
}

export async function create(env: Env, actor: Actor, organizationId: string, input: { name: string; description?: string; config?: unknown }) {
  await requireManager(env, actor, organizationId)
  const id = crypto.randomUUID()
  const config = input.config === undefined ? defaultConfig() : agentConfig.parse(input.config)
  await db
    .insertAgent(env.DB, {
      id,
      organizationId,
      name: name(input.name),
      description: (input.description ?? '').trim().slice(0, 300),
      draft: JSON.stringify(config),
      userId: actor.userId,
      now: new Date().toISOString(),
    })
    .run()
  return detail(env, (await db.findAgent(env.DB, id))!)
}

export async function get(env: Env, actor: Actor, agentId: string): Promise<AgentDetail> {
  return detail(env, await agentContext(env, actor, agentId))
}

/** Saves name, description and/or the whole draft config. The draft only takes effect when published. */
export async function update(env: Env, actor: Actor, agentId: string, input: { name?: string; description?: string; config?: unknown }) {
  const agent = await agentContext(env, actor, agentId)
  await db
    .updateAgent(env.DB, agent.id, {
      name: input.name === undefined ? undefined : name(input.name),
      description: input.description === undefined ? undefined : input.description.trim().slice(0, 300),
      draft: input.config === undefined ? undefined : JSON.stringify(agentConfig.parse(input.config)),
    })
    .run()
  return detail(env, (await db.findAgent(env.DB, agent.id))!)
}

/** Why a config can't run yet, or null. */
async function blocker(env: Env, organizationId: string, config: AgentConfig): Promise<string | null> {
  if (!config.model) return 'Pick a model in the agent’s Settings first.'
  const provider = await db.findProvider(env.DB, organizationId, config.model.provider)
  if (!provider) return `Add a ${label(config.model.provider)} key in Settings → AI providers first.`
  if (provider.status === 'invalid') return `${label(config.model.provider)} rejected the organization’s key. Update it in Settings → AI providers.`
  if (!config.instructions.trim()) return 'Write the agent’s instructions first.'
  return null
}

export async function publish(env: Env, actor: Actor, agentId: string) {
  const agent = await agentContext(env, actor, agentId)
  const problem = await blocker(env, agent.organization_id, parseConfig(agent.draft))
  if (problem) throw new ApiError('not_ready', problem, 409)
  await db.publish(env.DB, agent.id, actor.userId, new Date().toISOString())
  return detail(env, (await db.findAgent(env.DB, agent.id))!)
}

export async function setStatus(env: Env, actor: Actor, agentId: string, status: 'active' | 'paused') {
  const agent = await agentContext(env, actor, agentId)
  if (status === 'active') {
    const published = await publishedConfig(env, agent)
    if (!published) throw new ApiError('not_ready', 'Publish the agent before turning it on.', 409)
    const problem = await blocker(env, agent.organization_id, published.config)
    if (problem) throw new ApiError('not_ready', problem, 409)
  }
  await db.updateAgent(env.DB, agent.id, { status }).run()
  return detail(env, (await db.findAgent(env.DB, agent.id))!)
}

export async function duplicate(env: Env, actor: Actor, agentId: string) {
  const agent = await agentContext(env, actor, agentId)
  return create(env, actor, agent.organization_id, {
    name: `${agent.name} (copy)`.slice(0, 80),
    description: agent.description,
    config: parseConfig(agent.draft),
  })
}

export async function remove(env: Env, actor: Actor, agentId: string) {
  const agent = await agentContext(env, actor, agentId)
  await db.deleteAgent(env.DB, agent.id)
  await (await store(env, agent.id)).wipe()
}

export async function versions(env: Env, actor: Actor, agentId: string) {
  const agent = await agentContext(env, actor, agentId)
  return (await db.listVersions(env.DB, agent.id)).map((v) => ({
    version: v.version,
    publishedAt: v.published_at,
    publishedBy: v.published_by_name,
    config: parseConfig(v.config),
  }))
}

/** Copies a published version into the draft (publish again to make it live). */
export async function restoreVersion(env: Env, actor: Actor, agentId: string, version: number) {
  const agent = await agentContext(env, actor, agentId)
  const row = await db.findVersion(env.DB, agent.id, version)
  if (!row) throw new ApiError('not_found', 'No such version', 404)
  await db.updateAgent(env.DB, agent.id, { draft: JSON.stringify(parseConfig(row.config)) }).run()
  return detail(env, (await db.findAgent(env.DB, agent.id))!)
}

// ---------------------------------------------------------------------------------------------------------------
// Catalogs for the editor

export async function tools(env: Env, actor: Actor, organizationId: string) {
  await requireManager(env, actor, organizationId)
  return builtinCatalog()
}

/** The models the organization's keys can use, without the keys. */
export async function models(env: Env, actor: Actor, organizationId: string) {
  await requireManager(env, actor, organizationId)
  return (await db.listProviders(env.DB, organizationId)).map((p) => ({
    provider: p.provider,
    status: p.status,
    statusDetail: p.status_detail,
    models: JSON.parse(p.models) as string[],
  }))
}

// ---------------------------------------------------------------------------------------------------------------
// Runs

export type Run = {
  id: string
  status: RunRow['status']
  trigger: { kind: string; label: string }
  version: number | null
  dryRun: boolean
  model: string
  task: string
  startedAt: string
  finishedAt: string | null
  steps: number
  tokens: { input: number; output: number }
  summary: string | null
  error: string | null
}

const presentRun = (r: RunRow): Run => ({
  id: r.id,
  status: r.status,
  trigger: { kind: r.trigger_kind, label: r.trigger_label },
  version: r.version,
  dryRun: !!r.dry_run,
  model: r.model,
  task: r.task,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  steps: r.steps,
  tokens: { input: r.input_tokens, output: r.output_tokens },
  summary: r.summary,
  error: r.error,
})

/**
 * Runs the agent once with `task` as its input. `draft` tests the unpublished draft as the person asking; otherwise
 * the published version runs as its publisher. A dry run never calls tools that change anything.
 */
export async function startRun(env: Env, actor: Actor, agentId: string, input: { task: string; draft: boolean; dryRun: boolean }) {
  const agent = await agentContext(env, actor, agentId)
  const task = input.task.trim()
  if (!task) throw new ApiError('invalid_input', 'Give the agent something to work on')
  let config: AgentConfig
  let version: number | null = null
  let actorUserId = actor.userId
  if (input.draft) {
    config = parseConfig(agent.draft)
  } else {
    const published = await publishedConfig(env, agent)
    if (!published) throw new ApiError('not_ready', 'Publish the agent first, or test the draft.', 409)
    config = published.config
    version = agent.published_version
    if (!published.publishedBy) throw new ApiError('not_ready', 'The person who published this version left. Publish it again.', 409)
    actorUserId = published.publishedBy
  }
  const problem = await blocker(env, agent.organization_id, config)
  if (problem) throw new ApiError('not_ready', problem, 409)
  const result = await (await store(env, agent.id)).startRun(
    {
      organizationId: agent.organization_id,
      agentId: agent.id,
      version,
      actorUserId,
      config,
      task,
      dryRun: input.dryRun,
      trigger: input.draft ? { kind: 'test', label: 'Test' } : { kind: 'manual', label: 'Run now' },
    },
    config.limits.maxRunsPerDay,
  )
  if ('error' in result) throw new ApiError('limit_reached', result.error, 429)
  return result
}

export async function listRuns(env: Env, actor: Actor, agentId: string, q: { limit: number; before?: string; trigger?: string; status?: string; days?: number }) {
  const agent = await agentContext(env, actor, agentId)
  const since = q.days ? new Date(Date.now() - q.days * 86_400_000).toISOString() : undefined
  const rows = await (await store(env, agent.id)).listRuns({ limit: q.limit, before: q.before, trigger: q.trigger, status: q.status, since })
  return { runs: rows.map(presentRun), nextCursor: rows.length === q.limit ? rows.at(-1)!.started_at : null }
}

export async function getRun(env: Env, actor: Actor, agentId: string, runId: string) {
  const agent = await agentContext(env, actor, agentId)
  const found = await (await store(env, agent.id)).getRun(runId)
  if (!found) throw new ApiError('not_found', 'No such run', 404)
  return {
    run: presentRun(found.run),
    steps: found.steps.map((s: StepRow) => ({ seq: s.seq, at: s.at, kind: s.kind, detail: JSON.parse(s.detail) as unknown })),
  }
}

export async function stats(env: Env, actor: Actor, agentId: string) {
  const agent = await agentContext(env, actor, agentId)
  const s = await (await store(env, agent.id)).stats()
  return {
    runs7d: s.week.runs,
    successRate: s.week.finished ? s.week.ok / s.week.finished : null,
    tokens7d: s.week.tokens,
    month: s.month,
  }
}
