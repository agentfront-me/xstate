// Agents: create, edit the draft, publish, pause, duplicate, delete, version history, and runs.
// Owners, admins and members with the agents.manage permission can manage agents.
//
// Who a run acts as: a test of the draft acts as the person testing it; a run of the published version acts as the
// person who published that version (their access is checked again on every tool call, so removing them from the
// organization stops the agent's tools).

import { getAgentByName } from 'agents'
import type { Actor } from '../auth/types'
import * as db from '../db/agents'
import * as mailboxesDb from '../db/mailboxes'
import type { AgentRow } from '../db/agents'
import { ApiError } from '../errors'
import { isAdmin, loadMember } from '../mailserver/access'
import { agentConfig, defaultConfig, parseConfig, type AgentConfig } from './config'
import { formatUsd } from './prices'
import { label } from './providers'
import type { RunTrigger } from './run'
import type { AgentStore, FactRow, RunRow, StepRow } from './store'
import { pendingCounts } from './approvals'
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
  /** Tool calls waiting for a person (list only). */
  pendingApprovals?: number
  /** The most pressing problem, if any (list only). */
  issue?: Issue | null
  /** Estimated AI spend this month, USD (list only). */
  monthSpend?: number
}

/**
 * Something that stops or hurts the agent, with what fixes it: shown in the list and as a banner on its page.
 * Worst first: key problems stop every run; connectors stop some tools; the cap skips runs; failures are past runs.
 */
export type Issue =
  | { kind: 'key'; message: string; action: 'fix_key' }
  | { kind: 'connector'; message: string; action: 'sign_in'; connectorId: string }
  | { kind: 'spend'; message: string; action: 'raise_cap'; blocking: boolean }
  | { kind: 'failures'; message: string; action: 'retry'; count: number }

export type AgentDetail = AgentSummary & { draft: AgentConfig; published: AgentConfig | null }

const notFound = () => new ApiError('not_found', 'No such agent', 404)

async function requireManager(env: Env, actor: Actor, organizationId: string) {
  const member = await loadMember(env, organizationId, actor.userId)
  if (!isAdmin(member) && !member.permissions.org.includes('agents.manage')) {
    throw new ApiError('forbidden', 'Only owners, admins and people with the agents permission can manage agents', 403)
  }
  return member
}

export async function agentContext(env: Env, actor: Actor, agentId: string): Promise<AgentRow> {
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

export async function publishedConfig(env: Env, agent: AgentRow) {
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

/** Mailbox ids the agent may use in a run: its Settings → Mailboxes plus the mailboxes its email triggers watch. */
export async function agentMailboxes(env: Env, agentId: string, config: AgentConfig): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT DISTINCT mailbox_id FROM agent_triggers WHERE agent_id = ? AND kind = 'email' AND mailbox_id IS NOT NULL")
    .bind(agentId)
    .all<{ mailbox_id: string }>()
  return [...new Set([...config.mailboxes, ...results.map((r) => r.mailbox_id)])]
}

export const store = (env: Env, agentId: string) => getAgentByName<Env, AgentStore>(env.AGENT_STORE, agentId)

// ---------------------------------------------------------------------------------------------------------------
// Agents

export async function list(env: Env, actor: Actor, organizationId: string): Promise<AgentSummary[]> {
  await requireManager(env, actor, organizationId)
  const [agents, pending, providers, connectors] = await Promise.all([
    db.listAgents(env.DB, organizationId),
    pendingCounts(env, organizationId),
    db.listProviders(env.DB, organizationId),
    connectorStatuses(env, organizationId),
  ])
  return Promise.all(
    agents.map(async (a) => {
      const published = await publishedConfig(env, a)
      // Agents that never ran have nothing in their store worth waking it for.
      const h = published ? await (await store(env, a.id)).health() : { monthSpend: 0, failed24h: 0, lastError: null }
      const found = findIssues(published?.config ?? parseConfig(a.draft), providers, connectors, h)
      return { ...summary(a, published?.raw), pendingApprovals: pending.get(a.id) ?? 0, issue: found[0] ?? null, monthSpend: h.monthSpend }
    }),
  )
}

type ConnectorStatus = { id: string; name: string; status: string }

const connectorStatuses = async (env: Env, organizationId: string) =>
  (await env.DB.prepare('SELECT id, name, status FROM connectors WHERE organization_id = ?').bind(organizationId).all<ConnectorStatus>()).results

function findIssues(
  config: AgentConfig,
  providers: db.ProviderRow[],
  connectors: ConnectorStatus[],
  h: { monthSpend: number; failed24h: number; lastError: string | null },
): Issue[] {
  const issues: Issue[] = []
  if (config.model) {
    const name = label(config.model.provider)
    const p = providers.find((x) => x.provider === config.model!.provider)
    if (!p) issues.push({ kind: 'key', message: `No ${name} key: add one in Settings → AI providers.`, action: 'fix_key' })
    else if (p.status === 'invalid') issues.push({ kind: 'key', message: `${name} rejected the organization’s key.`, action: 'fix_key' })
    else if (p.status === 'no_credit') issues.push({ kind: 'key', message: `The ${name} account is out of credit.`, action: 'fix_key' })
  }
  for (const [id, tools] of Object.entries(config.tools.connectors)) {
    const c = connectors.find((x) => x.id === id)
    if (!tools.length || !c || c.status === 'connected') continue
    issues.push({
      kind: 'connector',
      message: c.status === 'needs_auth' ? `${c.name} needs someone to sign in again.` : `${c.name} isn’t working.`,
      action: 'sign_in',
      connectorId: c.id,
    })
  }
  const cap = config.spend.monthlyCapUsd
  if (cap !== null && h.monthSpend >= cap) {
    const blocking = config.spend.whenReached === 'pause'
    issues.push({
      kind: 'spend',
      message: blocking
        ? `Reached this month’s spend cap of ${formatUsd(cap)}: new runs are skipped until next month.`
        : `Over this month’s spend cap of ${formatUsd(cap)} (${formatUsd(h.monthSpend)} so far).`,
      action: 'raise_cap',
      blocking,
    })
  }
  if (h.failed24h) {
    issues.push({
      kind: 'failures',
      message: `${h.failed24h} run${h.failed24h === 1 ? '' : 's'} failed in the last day${h.lastError ? `: ${h.lastError.slice(0, 200)}` : '.'}`,
      action: 'retry',
      count: h.failed24h,
    })
  }
  return issues
}

/** The agent's problems (worst first), this month's spend against its cap, and how many facts it remembers. */
export async function health(env: Env, actor: Actor, agentId: string) {
  const agent = await agentContext(env, actor, agentId)
  const [published, providers, connectors, s] = await Promise.all([
    publishedConfig(env, agent),
    db.listProviders(env.DB, agent.organization_id),
    connectorStatuses(env, agent.organization_id),
    store(env, agent.id),
  ])
  const config = published?.config ?? parseConfig(agent.draft)
  const h = await s.health()
  return {
    issues: findIssues(config, providers, connectors, h),
    monthSpend: h.monthSpend,
    cap: config.spend.monthlyCapUsd,
    memoryFacts: await s.memoryCount(),
  }
}

const name = (s: string) => {
  const n = s.trim()
  if (!n || n.length > 80) throw new ApiError('invalid_name', 'Give the agent a name of up to 80 characters')
  return n
}

export async function create(env: Env, actor: Actor, organizationId: string, input: { name: string; description?: string; config?: unknown }) {
  await requireManager(env, actor, organizationId)
  const id = crypto.randomUUID()
  const config = input.config === undefined ? defaultConfig() : await scopedConfig(env, organizationId, agentConfig.parse(input.config))
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
      draft: input.config === undefined ? undefined : JSON.stringify(await scopedConfig(env, agent.organization_id, agentConfig.parse(input.config))),
    })
    .run()
  return detail(env, (await db.findAgent(env.DB, agent.id))!)
}

/** Drops mailboxes that aren't in the agent's organization (deleted, or a forged id). */
async function scopedConfig(env: Env, organizationId: string, config: AgentConfig): Promise<AgentConfig> {
  if (!config.mailboxes.length) return config
  const kept: string[] = []
  for (const id of new Set(config.mailboxes)) {
    const mailbox = await mailboxesDb.find(env.DB, id)
    if (mailbox?.organization_id === organizationId) kept.push(id)
  }
  return { ...config, mailboxes: kept }
}

/** Why a config can't run yet, or null. */
export async function blocker(env: Env, organizationId: string, config: AgentConfig): Promise<string | null> {
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
  trigger: { kind: string; label: string; triggerId: string | null }
  version: number | null
  dryRun: boolean
  model: string
  task: string
  startedAt: string
  finishedAt: string | null
  steps: number
  tokens: { input: number; output: number }
  /** Estimated USD. */
  cost: number
  summary: string | null
  error: string | null
  /** The run that retried this failed one. */
  retriedAs: string | null
}

const presentRun = (r: RunRow): Run => ({
  id: r.id,
  status: r.status,
  trigger: { kind: r.trigger_kind, label: r.trigger_label, triggerId: r.trigger_id ?? null },
  version: r.version,
  dryRun: !!r.dry_run,
  model: r.model,
  task: r.task,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  steps: r.steps,
  tokens: { input: r.input_tokens, output: r.output_tokens },
  cost: r.cost_usd ?? 0,
  summary: r.summary,
  error: r.error,
  retriedAs: r.retried_as ?? null,
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
      mailboxes: await agentMailboxes(env, agent.id, config),
    },
  )
  if ('skipped' in result) throw new ApiError('limit_reached', result.skipped, 429)
  return { runId: result.runId }
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
    cost7d: s.week.cost,
    avgCost: s.week.runs ? s.week.cost / s.week.runs : null,
    monthSpend: s.monthSpend,
    month: s.month,
  }
}

/** Runs failed runs from the last day again (up to 20, oldest first) with the published version, once each. */
export async function retryFailed(env: Env, actor: Actor, agentId: string) {
  const agent = await agentContext(env, actor, agentId)
  const published = await publishedConfig(env, agent)
  if (!published) throw new ApiError('not_ready', 'Publish the agent first.', 409)
  if (!published.publishedBy) throw new ApiError('not_ready', 'The person who published this version left. Publish it again.', 409)
  const problem = await blocker(env, agent.organization_id, published.config)
  if (problem) throw new ApiError('not_ready', problem, 409)
  const s = await store(env, agent.id)
  const mailboxes = await agentMailboxes(env, agent.id, published.config)
  let started = 0
  let skipped = 0
  let reason: string | null = null
  for (const run of await s.failedRuns(20)) {
    // An email trigger's AI filter applies again: the run may have failed before it was checked.
    const trigger = run.trigger_id ? await db.findTrigger(env.DB, run.trigger_id) : null
    const filter = trigger?.kind === 'email' ? ((JSON.parse(trigger.config) as { aiFilter?: string }).aiFilter || undefined) : undefined
    const result = await s.startRun({
      organizationId: agent.organization_id,
      agentId: agent.id,
      version: agent.published_version,
      actorUserId: published.publishedBy,
      config: published.config,
      task: run.task,
      dryRun: false,
      trigger: { kind: run.trigger_kind as RunTrigger['kind'], label: `${run.trigger_label} (retry)`.slice(0, 200), triggerId: run.trigger_id ?? undefined, sender: run.sender ?? undefined },
      filter,
      mailboxes,
    })
    await s.markRetried(run.id, result.runId)
    if ('skipped' in result) {
      skipped++
      reason = result.skipped
    } else started++
  }
  return { started, skipped, reason }
}

// ---------------------------------------------------------------------------------------------------------------
// Memory

export type Fact = { id: string; subject: string; fact: string; sourceRun: string | null; createdAt: string; updatedAt: string }

const presentFact = (f: FactRow): Fact => ({ id: f.id, subject: f.subject, fact: f.fact, sourceRun: f.source_run, createdAt: f.created_at, updatedAt: f.updated_at })

export async function listMemory(env: Env, actor: Actor, agentId: string, q: { query?: string; subject?: string }) {
  const agent = await agentContext(env, actor, agentId)
  const s = await store(env, agent.id)
  const facts = await s.recall({ query: q.query, subject: q.subject, limit: 500 })
  return { facts: facts.map(presentFact), total: await s.memoryCount() }
}

const factText = (v: string | undefined, what: string, max: number) => {
  if (v === undefined) return undefined
  const t = v.trim()
  if (!t || t.length > max) throw new ApiError('invalid_input', `Give the ${what} in up to ${max} characters`)
  return t
}

export async function addFact(env: Env, actor: Actor, agentId: string, input: { subject: string; fact: string }) {
  const agent = await agentContext(env, actor, agentId)
  const row = await (await store(env, agent.id)).remember(factText(input.subject, 'subject', 200)!, factText(input.fact, 'fact', 1000)!, null)
  return presentFact(row)
}

export async function updateFact(env: Env, actor: Actor, agentId: string, factId: string, input: { subject?: string; fact?: string }) {
  const agent = await agentContext(env, actor, agentId)
  const row = await (await store(env, agent.id)).updateFact(factId, { subject: factText(input.subject, 'subject', 200), fact: factText(input.fact, 'fact', 1000) })
  if (!row) throw new ApiError('not_found', 'No such fact', 404)
  return presentFact(row)
}

export async function deleteFact(env: Env, actor: Actor, agentId: string, factId: string) {
  const agent = await agentContext(env, actor, agentId)
  if (!(await (await store(env, agent.id)).forget(factId))) throw new ApiError('not_found', 'No such fact', 404)
}

export async function clearMemory(env: Env, actor: Actor, agentId: string) {
  const agent = await agentContext(env, actor, agentId)
  return { deleted: await (await store(env, agent.id)).clearMemory() }
}
