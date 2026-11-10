// Agents, AI providers and secrets (docs/agents-plan.md). All kept off MCP for now: an outside agent shouldn't read
// or change another agent's setup, the organization's AI keys or its secrets.

import { z } from 'zod'
import { PROVIDERS } from '../agents/config'
import * as providers from '../agents/providers'
import * as secrets from '../agents/secrets'
import * as approvals from '../agents/approvals'
import * as connectors from '../agents/connectors'
import * as agents from '../agents/service'
import * as designer from '../agents/designer'
import { TEMPLATES } from '../agents/templates'
import * as triggers from '../agents/triggers'
import { defineOperation } from './define'

const id = z.string().min(1).max(64)
const provider = z.enum(PROVIDERS)

// ---------------------------------------------------------------------------------------------------------------
// AI providers (owners and admins)

export const aiProvidersList = defineOperation({
  name: 'ai_providers_list',
  description: "The organization's AI provider keys (masked), their status and the models they can use.",
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/orgs/:organizationId/ai-providers' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ providers: await providers.list(env, actor, input.organizationId) }),
})

export const aiProvidersSave = defineOperation({
  name: 'ai_providers_save',
  description: "Check and save the organization's key for a provider, replacing the current one.",
  input: z.object({ organizationId: id, provider, apiKey: z.string().min(1).max(500) }),
  http: { method: 'PUT', path: '/orgs/:organizationId/ai-providers/:provider' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ provider: await providers.save(env, actor, input.organizationId, input.provider, input.apiKey) }),
})

export const aiProvidersCheck = defineOperation({
  name: 'ai_providers_check',
  description: 'Check the saved key again and refresh the list of models it can use.',
  input: z.object({ organizationId: id, provider }),
  http: { method: 'POST', path: '/orgs/:organizationId/ai-providers/:provider/check' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ provider: await providers.recheck(env, actor, input.organizationId, input.provider) }),
})

export const aiProvidersRemove = defineOperation({
  name: 'ai_providers_remove',
  description: "Remove the organization's key for a provider. Agents using it stop until another model is picked.",
  input: z.object({ organizationId: id, provider }),
  http: { method: 'DELETE', path: '/orgs/:organizationId/ai-providers/:provider' },
  mcp: false,
  run: ({ env, actor }, input) => providers.remove(env, actor, input.organizationId, input.provider),
})

// ---------------------------------------------------------------------------------------------------------------
// Secrets (owners and admins)

const secretName = z.string().min(1).max(64)

export const secretsList = defineOperation({
  name: 'secrets_list',
  description: "The organization's secrets: names and dates only. Values can't be read back.",
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/orgs/:organizationId/secrets' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ secrets: await secrets.list(env, actor, input.organizationId) }),
})

export const secretsSave = defineOperation({
  name: 'secrets_save',
  description: 'Create a secret, or replace the value of an existing one.',
  input: z.object({ organizationId: id, name: secretName, value: z.string().max(8000) }),
  http: { method: 'PUT', path: '/orgs/:organizationId/secrets/:name' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ secrets: await secrets.save(env, actor, input.organizationId, input.name, input.value) }),
})

export const secretsRemove = defineOperation({
  name: 'secrets_remove',
  description: 'Delete a secret.',
  input: z.object({ organizationId: id, name: secretName }),
  http: { method: 'DELETE', path: '/orgs/:organizationId/secrets/:name' },
  mcp: false,
  run: ({ env, actor }, input) => secrets.remove(env, actor, input.organizationId, input.name),
})

// ---------------------------------------------------------------------------------------------------------------
// Agents (owners, admins and agents.manage)

export const agentsList = defineOperation({
  name: 'agents_list',
  description: "The organization's agents.",
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/agents/orgs/:organizationId' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ agents: await agents.list(env, actor, input.organizationId) }),
})

export const agentsCreate = defineOperation({
  name: 'agents_create',
  description: 'Create an agent. It starts paused and unpublished, with the given draft config or an empty one.',
  input: z.object({ organizationId: id, name: z.string().max(200), description: z.string().max(1000).optional(), config: z.unknown().optional() }),
  http: { method: 'POST', path: '/agents/orgs/:organizationId', status: 201 },
  mcp: false,
  run: async ({ env, actor }, { organizationId, ...input }) => ({ agent: await agents.create(env, actor, organizationId, input) }),
})

export const agentsTools = defineOperation({
  name: 'agents_tools',
  description: 'The built-in tools an agent can be given.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/agents/orgs/:organizationId/tools' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ tools: await agents.tools(env, actor, input.organizationId) }),
})

export const agentsModels = defineOperation({
  name: 'agents_models',
  description: "The models the organization's AI keys can use.",
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/agents/orgs/:organizationId/models' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ providers: await agents.models(env, actor, input.organizationId) }),
})

export const agentsGet = defineOperation({
  name: 'agents_get',
  description: 'One agent with its draft and published config.',
  input: z.object({ agentId: id }),
  http: { method: 'GET', path: '/agents/:agentId' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ agent: await agents.get(env, actor, input.agentId) }),
})

export const agentsUpdate = defineOperation({
  name: 'agents_update',
  description: "Change an agent's name, description or draft config. The draft only takes effect when published.",
  input: z.object({ agentId: id, name: z.string().max(200).optional(), description: z.string().max(1000).optional(), config: z.unknown().optional() }),
  http: { method: 'PATCH', path: '/agents/:agentId' },
  mcp: false,
  run: async ({ env, actor }, { agentId, ...input }) => ({ agent: await agents.update(env, actor, agentId, input) }),
})

export const agentsPublish = defineOperation({
  name: 'agents_publish',
  description: "Publish the agent's draft as its next version.",
  input: z.object({ agentId: id }),
  http: { method: 'POST', path: '/agents/:agentId/publish' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ agent: await agents.publish(env, actor, input.agentId) }),
})

export const agentsSetStatus = defineOperation({
  name: 'agents_set_status',
  description: 'Turn an agent on (active) or off (paused).',
  input: z.object({ agentId: id, status: z.enum(['active', 'paused']) }),
  http: { method: 'POST', path: '/agents/:agentId/status' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ agent: await agents.setStatus(env, actor, input.agentId, input.status) }),
})

export const agentsDuplicate = defineOperation({
  name: 'agents_duplicate',
  description: "Copy an agent's setup into a new paused agent. Runs aren't copied.",
  input: z.object({ agentId: id }),
  http: { method: 'POST', path: '/agents/:agentId/duplicate', status: 201 },
  mcp: false,
  run: async ({ env, actor }, input) => ({ agent: await agents.duplicate(env, actor, input.agentId) }),
})

export const agentsDelete = defineOperation({
  name: 'agents_delete',
  description: 'Delete an agent with its versions and runs.',
  input: z.object({ agentId: id }),
  http: { method: 'DELETE', path: '/agents/:agentId' },
  mcp: false,
  run: ({ env, actor }, input) => agents.remove(env, actor, input.agentId),
})

export const agentsVersions = defineOperation({
  name: 'agents_versions',
  description: "An agent's published versions, newest first.",
  input: z.object({ agentId: id }),
  http: { method: 'GET', path: '/agents/:agentId/versions' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ versions: await agents.versions(env, actor, input.agentId) }),
})

export const agentsRestoreVersion = defineOperation({
  name: 'agents_restore_version',
  description: 'Copy a published version into the draft.',
  input: z.object({ agentId: id, version: z.coerce.number().int().min(1) }),
  http: { method: 'POST', path: '/agents/:agentId/versions/:version/restore' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ agent: await agents.restoreVersion(env, actor, input.agentId, input.version) }),
})

export const agentsStartRun = defineOperation({
  name: 'agents_start_run',
  description: 'Run the agent once on a task. draft: test the unpublished draft. dryRun: never change anything.',
  input: z.object({ agentId: id, task: z.string().max(20_000), draft: z.boolean().default(true), dryRun: z.boolean().default(true) }),
  http: { method: 'POST', path: '/agents/:agentId/runs', status: 201 },
  mcp: false,
  run: ({ env, actor }, { agentId, ...input }) => agents.startRun(env, actor, agentId, input),
})

export const agentsListRuns = defineOperation({
  name: 'agents_list_runs',
  description: "An agent's runs, newest first. Pass nextCursor back as before for the next page.",
  input: z.object({
    agentId: id,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().max(40).optional(),
    trigger: z.string().max(20).optional(),
    status: z.string().max(30).optional(),
    days: z.coerce.number().int().min(1).max(365).optional(),
  }),
  http: { method: 'GET', path: '/agents/:agentId/runs' },
  mcp: false,
  run: ({ env, actor }, { agentId, ...q }) => agents.listRuns(env, actor, agentId, q),
})

export const agentsGetRun = defineOperation({
  name: 'agents_get_run',
  description: 'One run with every step: model calls, tool calls and their results.',
  input: z.object({ agentId: id, runId: id }),
  http: { method: 'GET', path: '/agents/:agentId/runs/:runId' },
  mcp: false,
  run: ({ env, actor }, input) => agents.getRun(env, actor, input.agentId, input.runId),
})

export const agentsStats = defineOperation({
  name: 'agents_stats',
  description: "An agent's runs in the last 7 days, success rate and this month's tokens by model.",
  input: z.object({ agentId: id }),
  http: { method: 'GET', path: '/agents/:agentId/stats' },
  mcp: false,
  run: ({ env, actor }, input) => agents.stats(env, actor, input.agentId),
})

export const agentsTemplates = defineOperation({
  name: 'agents_templates',
  description: 'Ready-made starting points for a new agent: instructions, tools, approvals and a suggested trigger.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/agents/orgs/:organizationId/templates' },
  mcp: false,
  run: async ({ env, actor }, input) => {
    await agents.tools(env, actor, input.organizationId) // same access check as the editor's catalogs
    return { templates: TEMPLATES }
  },
})

export const agentsDraft = defineOperation({
  name: 'agents_draft',
  description: "Draft a new agent's setup from a description, with the organization's AI key. Nothing is saved.",
  input: z.object({
    organizationId: id,
    prompt: z.string().trim().min(10, 'Describe what the agent should do in a sentence or two').max(4000),
    model: z.object({ provider, id: z.string().min(1).max(100) }),
  }),
  http: { method: 'POST', path: '/agents/orgs/:organizationId/draft' },
  mcp: false,
  run: async ({ env, actor }, { organizationId, ...input }) => ({ draft: await designer.draft(env, actor, organizationId, input) }),
})

export const agentsHealth = defineOperation({
  name: 'agents_health',
  description: "What's wrong with an agent (key, connectors, spend cap, failed runs) and how to fix it, plus this month's spend.",
  input: z.object({ agentId: id }),
  http: { method: 'GET', path: '/agents/:agentId/health' },
  mcp: false,
  run: ({ env, actor }, input) => agents.health(env, actor, input.agentId),
})

export const agentsRetryFailed = defineOperation({
  name: 'agents_retry_failed',
  description: 'Run the failed runs of the last day again with the published version, once each.',
  input: z.object({ agentId: id }),
  http: { method: 'POST', path: '/agents/:agentId/runs/retry-failed' },
  mcp: false,
  run: ({ env, actor }, input) => agents.retryFailed(env, actor, input.agentId),
})

// ---------------------------------------------------------------------------------------------------------------
// Memory (same people as the agent)

export const memoryList = defineOperation({
  name: 'agents_memory_list',
  description: 'Facts the agent remembers, newest first. query searches subjects and facts.',
  input: z.object({ agentId: id, query: z.string().max(200).optional(), subject: z.string().max(200).optional() }),
  http: { method: 'GET', path: '/agents/:agentId/memory' },
  mcp: false,
  run: ({ env, actor }, { agentId, ...q }) => agents.listMemory(env, actor, agentId, q),
})

export const memoryAdd = defineOperation({
  name: 'agents_memory_add',
  description: 'Add a fact to the agent’s memory.',
  input: z.object({ agentId: id, subject: z.string().max(200), fact: z.string().max(1000) }),
  http: { method: 'POST', path: '/agents/:agentId/memory', status: 201 },
  mcp: false,
  run: async ({ env, actor }, { agentId, ...input }) => ({ fact: await agents.addFact(env, actor, agentId, input) }),
})

export const memoryUpdate = defineOperation({
  name: 'agents_memory_update',
  description: 'Change a remembered fact.',
  input: z.object({ agentId: id, factId: id, subject: z.string().max(200).optional(), fact: z.string().max(1000).optional() }),
  http: { method: 'PATCH', path: '/agents/:agentId/memory/:factId' },
  mcp: false,
  run: async ({ env, actor }, { agentId, factId, ...input }) => ({ fact: await agents.updateFact(env, actor, agentId, factId, input) }),
})

export const memoryDelete = defineOperation({
  name: 'agents_memory_delete',
  description: 'Delete a remembered fact.',
  input: z.object({ agentId: id, factId: id }),
  http: { method: 'DELETE', path: '/agents/:agentId/memory/:factId' },
  mcp: false,
  run: async ({ env, actor }, input) => {
    await agents.deleteFact(env, actor, input.agentId, input.factId)
    return { ok: true }
  },
})

export const memoryClear = defineOperation({
  name: 'agents_memory_clear',
  description: 'Delete everything the agent remembers.',
  input: z.object({ agentId: id }),
  http: { method: 'DELETE', path: '/agents/:agentId/memory' },
  mcp: false,
  run: ({ env, actor }, input) => agents.clearMemory(env, actor, input.agentId),
})

// ---------------------------------------------------------------------------------------------------------------
// Triggers (same people as the agent)

const triggerKind = z.enum(['webhook', 'schedule', 'email'])

export const triggersList = defineOperation({
  name: 'agents_triggers_list',
  description: "An agent's triggers: webhooks, schedules and email.",
  input: z.object({ agentId: id }),
  http: { method: 'GET', path: '/agents/:agentId/triggers' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ triggers: await triggers.list(env, actor, input.agentId) }),
})

export const triggersCreate = defineOperation({
  name: 'agents_triggers_create',
  description: 'Add a trigger. Webhooks get a new secret; email triggers start from the mail that arrives next.',
  input: z.object({ agentId: id, kind: triggerKind, config: z.unknown() }),
  http: { method: 'POST', path: '/agents/:agentId/triggers', status: 201 },
  mcp: false,
  run: async ({ env, actor }, { agentId, ...input }) => ({ trigger: await triggers.create(env, actor, agentId, input) }),
})

export const triggersUpdate = defineOperation({
  name: 'agents_triggers_update',
  description: 'Turn a trigger on or off, or change its settings.',
  input: z.object({ agentId: id, triggerId: id, enabled: z.boolean().optional(), config: z.unknown().optional() }),
  http: { method: 'PATCH', path: '/agents/:agentId/triggers/:triggerId' },
  mcp: false,
  run: async ({ env, actor }, { agentId, triggerId, ...input }) => ({ trigger: await triggers.update(env, actor, agentId, triggerId, input) }),
})

export const triggersDelete = defineOperation({
  name: 'agents_triggers_delete',
  description: 'Delete a trigger.',
  input: z.object({ agentId: id, triggerId: id }),
  http: { method: 'DELETE', path: '/agents/:agentId/triggers/:triggerId' },
  mcp: false,
  run: ({ env, actor }, input) => triggers.remove(env, actor, input.agentId, input.triggerId),
})

export const triggersRevealSecret = defineOperation({
  name: 'agents_triggers_reveal_secret',
  description: "A webhook trigger's secret and full URL.",
  input: z.object({ agentId: id, triggerId: id }),
  http: { method: 'POST', path: '/agents/:agentId/triggers/:triggerId/secret/reveal' },
  mcp: false,
  run: ({ env, actor }, input) => triggers.revealSecret(env, actor, input.agentId, input.triggerId),
})

export const triggersRotateSecret = defineOperation({
  name: 'agents_triggers_rotate_secret',
  description: 'Replace a webhook trigger’s secret. The old one stops working right away.',
  input: z.object({ agentId: id, triggerId: id }),
  http: { method: 'POST', path: '/agents/:agentId/triggers/:triggerId/secret/rotate' },
  mcp: false,
  run: ({ env, actor }, input) => triggers.rotateSecret(env, actor, input.agentId, input.triggerId),
})

export const triggersEvents = defineOperation({
  name: 'agents_triggers_events',
  description: 'What a trigger received lately (payloads, emails, schedule times) and whether it started a run.',
  input: z.object({ agentId: id, triggerId: id }),
  http: { method: 'GET', path: '/agents/:agentId/triggers/:triggerId/events' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ events: await triggers.events(env, actor, input.agentId, input.triggerId) }),
})

export const triggersTest = defineOperation({
  name: 'agents_triggers_test',
  description: 'Send a test event through a trigger: a dry run of the draft, as you.',
  input: z.object({ agentId: id, triggerId: id, payload: z.string().max(256 * 1024).optional() }),
  http: { method: 'POST', path: '/agents/:agentId/triggers/:triggerId/test', status: 201 },
  mcp: false,
  run: ({ env, actor }, { agentId, triggerId, ...input }) => triggers.test(env, actor, agentId, triggerId, input),
})

// ---------------------------------------------------------------------------------------------------------------
// Approvals

export const approvalsList = defineOperation({
  name: 'agents_approvals_list',
  description: "An agent's tool calls waiting for a person (pending), or the latest decided ones.",
  input: z.object({ agentId: id, status: z.enum(['pending', 'decided']).default('pending') }),
  http: { method: 'GET', path: '/agents/:agentId/approvals' },
  mcp: false,
  run: ({ env, actor }, input) => approvals.list(env, actor, input.agentId, input.status),
})

export const approvalsPending = defineOperation({
  name: 'agents_approvals_pending',
  description: 'How many tool calls in the organization wait for a person: 0 for people who don’t manage agents.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/agents/orgs/:organizationId/approvals/pending' },
  mcp: false,
  run: ({ env, actor }, input) => approvals.pendingTotal(env, actor, input.organizationId),
})

export const approvalsDecide = defineOperation({
  name: 'agents_approvals_decide',
  description: 'Approve (optionally with changed input) or reject a waiting tool call. A rejection note goes back to the agent.',
  input: z.object({
    agentId: id,
    approvalId: z.string().min(1).max(120),
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(2000).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  http: { method: 'POST', path: '/agents/:agentId/approvals/:approvalId' },
  mcp: false,
  run: async ({ env, actor }, { agentId, approvalId, ...input }) => ({ approval: await approvals.decide(env, actor, agentId, approvalId, input) }),
})

// ---------------------------------------------------------------------------------------------------------------
// Connectors (owners and admins change them; people who manage agents can see and refresh them)

const header = z.object({ name: z.string().max(64), value: z.string().max(4000) })

export const connectorsList = defineOperation({
  name: 'connectors_list',
  description: "The organization's MCP connectors: URL, sign-in method, status and the tools each offers.",
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/orgs/:organizationId/connectors' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ connectors: await connectors.list(env, actor, input.organizationId) }),
})

export const connectorsCreate = defineOperation({
  name: 'connectors_create',
  description: 'Add an MCP server by URL. With OAuth, the result has authUrl to sign in at.',
  input: z.object({
    organizationId: id,
    name: z.string().max(200),
    url: z.string().max(2000),
    auth: z.enum(['none', 'headers', 'oauth']),
    headers: z.array(header).max(20).optional(),
  }),
  http: { method: 'POST', path: '/orgs/:organizationId/connectors', status: 201 },
  mcp: false,
  run: ({ env, actor }, { organizationId, ...input }) => connectors.create(env, actor, organizationId, input),
})

export const connectorsUpdate = defineOperation({
  name: 'connectors_update',
  description: "Rename a connector, change its URL or headers. Its tools are discovered again.",
  input: z.object({ organizationId: id, connectorId: id, name: z.string().max(200).optional(), url: z.string().max(2000).optional(), headers: z.array(header).max(20).optional() }),
  http: { method: 'PATCH', path: '/orgs/:organizationId/connectors/:connectorId' },
  mcp: false,
  run: async ({ env, actor }, { organizationId, connectorId, ...input }) => ({ connector: await connectors.update(env, actor, organizationId, connectorId, input) }),
})

export const connectorsDelete = defineOperation({
  name: 'connectors_delete',
  description: 'Remove a connector. Agents lose its tools.',
  input: z.object({ organizationId: id, connectorId: id }),
  http: { method: 'DELETE', path: '/orgs/:organizationId/connectors/:connectorId' },
  mcp: false,
  run: ({ env, actor }, input) => connectors.remove(env, actor, input.organizationId, input.connectorId),
})

export const connectorsRefresh = defineOperation({
  name: 'connectors_refresh',
  description: 'Connect again and refresh the list of tools.',
  input: z.object({ organizationId: id, connectorId: id }),
  http: { method: 'POST', path: '/orgs/:organizationId/connectors/:connectorId/refresh' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ connector: await connectors.refresh(env, actor, input.organizationId, input.connectorId) }),
})

export const connectorsAuthorize = defineOperation({
  name: 'connectors_authorize',
  description: 'Start signing in to an OAuth connector again. Returns authUrl to open (null when still signed in).',
  input: z.object({ organizationId: id, connectorId: id }),
  http: { method: 'POST', path: '/orgs/:organizationId/connectors/:connectorId/authorize' },
  mcp: false,
  run: ({ env, actor }, input) => connectors.authorize(env, actor, input.organizationId, input.connectorId),
})

export const agentOperations = [
  connectorsList,
  connectorsCreate,
  connectorsUpdate,
  connectorsDelete,
  connectorsRefresh,
  connectorsAuthorize,
  approvalsList,
  approvalsDecide,
  approvalsPending,
  agentsHealth,
  agentsTemplates,
  agentsDraft,
  agentsRetryFailed,
  memoryList,
  memoryAdd,
  memoryUpdate,
  memoryDelete,
  memoryClear,
  triggersList,
  triggersCreate,
  triggersUpdate,
  triggersDelete,
  triggersRevealSecret,
  triggersRotateSecret,
  triggersEvents,
  triggersTest,
  aiProvidersList,
  aiProvidersSave,
  aiProvidersCheck,
  aiProvidersRemove,
  secretsList,
  secretsSave,
  secretsRemove,
  agentsList,
  agentsCreate,
  agentsTools,
  agentsModels,
  agentsGet,
  agentsUpdate,
  agentsPublish,
  agentsSetStatus,
  agentsDuplicate,
  agentsDelete,
  agentsVersions,
  agentsRestoreVersion,
  agentsStartRun,
  agentsListRuns,
  agentsGetRun,
  agentsStats,
]
