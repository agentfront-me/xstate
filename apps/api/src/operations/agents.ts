// Agents, AI providers and secrets (docs/agents-plan.md). All kept off MCP for now: an outside agent shouldn't read
// or change another agent's setup, the organization's AI keys or its secrets.

import { z } from 'zod'
import { PROVIDERS } from '../agents/config'
import * as providers from '../agents/providers'
import * as secrets from '../agents/secrets'
import * as approvals from '../agents/approvals'
import * as agents from '../agents/service'
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
  description: 'Create an agent. It starts paused, with an empty draft.',
  input: z.object({ organizationId: id, name: z.string().max(200), description: z.string().max(1000).optional() }),
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

export const agentOperations = [
  approvalsList,
  approvalsDecide,
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
