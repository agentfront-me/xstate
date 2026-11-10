// The agents_*, ai_providers_* and secrets_* API (apps/api/src/operations/agents.ts).

import { api } from '../lib/core'

export type ProviderId = 'anthropic' | 'openai'
export type ProviderStatus = 'valid' | 'invalid' | 'no_credit' | 'rate_limited'

export type AgentConfig = {
  instructions: string
  model: { provider: ProviderId; id: string } | null
  tools: {
    builtin: string[]
    approval: Record<string, 'always' | 'never' | 'when'>
    connectors: Record<string, string[]>
    conditions: Record<string, Condition>
  }
  mailboxes: string[]
  approvals: { timeoutHours: number; onTimeout: 'reject' | 'wait'; approvers: string[]; notifyEmail: boolean }
  limits: { maxSteps: number; maxRunsPerDay: number; perSenderPerHour: number }
  spend: { monthlyCapUsd: number | null; whenReached: 'pause' | 'notify' }
  memory: { enabled: boolean; retentionDays: number | null }
}

/** What's wrong with an agent and what fixes it (worst first). */
export type Issue =
  | { kind: 'key'; message: string; action: 'fix_key' }
  | { kind: 'connector'; message: string; action: 'sign_in'; connectorId: string }
  | { kind: 'spend'; message: string; action: 'raise_cap'; blocking: boolean }
  | { kind: 'failures'; message: string; action: 'retry'; count: number }

export type Health = { issues: Issue[]; monthSpend: number; cap: number | null; memoryFacts: number }
export type Fact = { id: string; subject: string; fact: string; sourceRun: string | null; createdAt: string; updatedAt: string }

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
  pendingApprovals?: number
  issue?: Issue | null
  monthSpend?: number
}

export type Agent = AgentSummary & { draft: AgentConfig; published: AgentConfig | null }

export type ToolInfo = { name: string; label: string; group: string; description: string; readOnly: boolean; defaultApproval: 'always' | 'never' }
export type ModelChoice = { provider: ProviderId; status: ProviderStatus; statusDetail: string | null; models: string[] }

export type RunStatus = 'running' | 'waiting_for_approval' | 'done' | 'failed' | 'max_steps' | 'skipped'
export type Run = {
  id: string
  status: RunStatus
  trigger: { kind: string; label: string; triggerId: string | null }
  version: number | null
  dryRun: boolean
  model: string
  task: string
  startedAt: string
  finishedAt: string | null
  steps: number
  tokens: { input: number; output: number }
  cost: number
  summary: string | null
  error: string | null
  retriedAs: string | null
}

export type RunStep =
  | { seq: number; at: string; kind: 'model'; detail: { text: string; calls: { toolName: string; input: unknown }[]; tokens: { input: number; output: number } } }
  | { seq: number; at: string; kind: 'tool'; detail: { tool: string; input: unknown; output: unknown } }
  | { seq: number; at: string; kind: string; detail: Record<string, unknown> }

export type Stats = {
  runs7d: number
  successRate: number | null
  tokens7d: number
  cost7d: number
  avgCost: number | null
  monthSpend: number
  month: { model: string; input: number; output: number; runs: number; cost: number }[]
}
export type Version = { version: number; publishedAt: string; publishedBy: string | null; config: AgentConfig }

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
  usedBy: number
}

export type Secret = { name: string; createdAt: string; updatedAt: string; lastUsedAt: string | null; usedBy: string[] }

export const agentKeys = {
  all: ['agents'] as const,
  list: (orgId: string) => ['agents', 'list', orgId] as const,
  one: (id: string) => ['agents', 'one', id] as const,
  runs: (id: string) => ['agents', 'runs', id] as const,
  run: (id: string, runId: string) => ['agents', 'run', id, runId] as const,
  stats: (id: string) => ['agents', 'stats', id] as const,
  health: (id: string) => ['agents', 'health', id] as const,
  memory: (id: string, query: string) => ['agents', 'memory', id, query] as const,
  pending: (orgId: string) => ['agents', 'pending', orgId] as const,
  tools: (orgId: string) => ['agents', 'tools', orgId] as const,
  models: (orgId: string) => ['agents', 'models', orgId] as const,
  providers: (orgId: string) => ['ai-providers', orgId] as const,
  secrets: (orgId: string) => ['secrets', orgId] as const,
}

export const agentsApi = {
  list: (orgId: string) => api<{ agents: AgentSummary[] }>('GET', `/agents/orgs/${orgId}`),
  create: (orgId: string, input: { name: string; description?: string }) => api<{ agent: Agent }>('POST', `/agents/orgs/${orgId}`, input),
  tools: (orgId: string) => api<{ tools: ToolInfo[] }>('GET', `/agents/orgs/${orgId}/tools`),
  models: (orgId: string) => api<{ providers: ModelChoice[] }>('GET', `/agents/orgs/${orgId}/models`),
  get: (id: string) => api<{ agent: Agent }>('GET', `/agents/${id}`),
  update: (id: string, input: { name?: string; description?: string; config?: AgentConfig }) => api<{ agent: Agent }>('PATCH', `/agents/${id}`, input),
  publish: (id: string) => api<{ agent: Agent }>('POST', `/agents/${id}/publish`),
  setStatus: (id: string, status: 'active' | 'paused') => api<{ agent: Agent }>('POST', `/agents/${id}/status`, { status }),
  duplicate: (id: string) => api<{ agent: Agent }>('POST', `/agents/${id}/duplicate`),
  remove: (id: string) => api<void>('DELETE', `/agents/${id}`),
  versions: (id: string) => api<{ versions: Version[] }>('GET', `/agents/${id}/versions`),
  restore: (id: string, version: number) => api<{ agent: Agent }>('POST', `/agents/${id}/versions/${version}/restore`),
  startRun: (id: string, input: { task: string; draft: boolean; dryRun: boolean }) => api<{ runId: string }>('POST', `/agents/${id}/runs`, input),
  runs: (id: string, q: { trigger?: string; status?: string; days?: number; before?: string } = {}) => {
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))
    return api<{ runs: Run[]; nextCursor: string | null }>('GET', `/agents/${id}/runs${params.size ? `?${params}` : ''}`)
  },
  run: (id: string, runId: string) => api<{ run: Run; steps: RunStep[] }>('GET', `/agents/${id}/runs/${runId}`),
  stats: (id: string) => api<Stats>('GET', `/agents/${id}/stats`),
  health: (id: string) => api<Health>('GET', `/agents/${id}/health`),
  retryFailed: (id: string) => api<{ started: number; skipped: number; reason: string | null }>('POST', `/agents/${id}/runs/retry-failed`),
  pending: (orgId: string) => api<{ count: number }>('GET', `/agents/orgs/${orgId}/approvals/pending`),
}

export const memoryApi = {
  list: (id: string, query = '') => api<{ facts: Fact[]; total: number }>('GET', `/agents/${id}/memory${query ? `?query=${encodeURIComponent(query)}` : ''}`),
  add: (id: string, input: { subject: string; fact: string }) => api<{ fact: Fact }>('POST', `/agents/${id}/memory`, input),
  update: (id: string, factId: string, input: { subject?: string; fact?: string }) => api<{ fact: Fact }>('PATCH', `/agents/${id}/memory/${factId}`, input),
  remove: (id: string, factId: string) => api<void>('DELETE', `/agents/${id}/memory/${factId}`),
  clear: (id: string) => api<{ deleted: number }>('DELETE', `/agents/${id}/memory`),
}

/** "$0.0017", "$0.013", "$18.40", "$250" (same as the API's formatUsd). */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd)}`
}

export const providersApi = {
  list: (orgId: string) => api<{ providers: Provider[] }>('GET', `/orgs/${orgId}/ai-providers`),
  save: (orgId: string, provider: ProviderId, apiKey: string) => api<{ provider: Provider }>('PUT', `/orgs/${orgId}/ai-providers/${provider}`, { apiKey }),
  check: (orgId: string, provider: ProviderId) => api<{ provider: Provider }>('POST', `/orgs/${orgId}/ai-providers/${provider}/check`),
  remove: (orgId: string, provider: ProviderId) => api<void>('DELETE', `/orgs/${orgId}/ai-providers/${provider}`),
}

export const secretsApi = {
  list: (orgId: string) => api<{ secrets: Secret[] }>('GET', `/orgs/${orgId}/secrets`),
  save: (orgId: string, name: string, value: string) => api<{ secrets: Secret[] }>('PUT', `/orgs/${orgId}/secrets/${encodeURIComponent(name)}`, { value }),
  remove: (orgId: string, name: string) => api<void>('DELETE', `/orgs/${orgId}/secrets/${encodeURIComponent(name)}`),
}

export const PROVIDER_LABEL: Record<ProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }
export const PROVIDER_CONSOLE: Record<ProviderId, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
}

export const STATUS_LABEL: Record<ProviderStatus, string> = {
  valid: 'Valid',
  invalid: 'Key rejected',
  no_credit: 'Out of credit',
  rate_limited: 'Rate limited',
}

export const RUN_STATUS: Record<RunStatus, { label: string; icon: 'circle-check' | 'circle-x' | 'clock' | 'circle-dashed' | 'circle-alert' }> = {
  running: { label: 'Running', icon: 'circle-dashed' },
  waiting_for_approval: { label: 'Waiting for approval', icon: 'clock' },
  done: { label: 'Done', icon: 'circle-check' },
  failed: { label: 'Failed', icon: 'circle-x' },
  max_steps: { label: 'Hit step limit', icon: 'circle-alert' },
  skipped: { label: 'Skipped', icon: 'circle-dashed' },
}

// ---------------------------------------------------------------------------------------------------------------
// Triggers

export type TriggerKind = 'webhook' | 'schedule' | 'email'
export type WebhookConfig = { name: string; auth: 'signature' | 'url'; template: string }
export type Frequency = 'once' | 'interval' | 'daily' | 'weekly' | 'cron'
export type ScheduleConfig = {
  frequency: Frequency
  timezone: string
  at?: string
  everyMinutes?: number
  time?: string
  weekdays?: number[]
  cron?: string
  task: string
}
export type EmailConfig = {
  mailboxId: string
  rules: { from: string; subjectContains: string; hasAttachment: boolean | null }
  aiFilter: string
  skipAutomated: boolean
}
export type Trigger = {
  id: string
  kind: TriggerKind
  enabled: boolean
  config: WebhookConfig | ScheduleConfig | EmailConfig
  summary: string
  lastFiredAt: string | null
  nextRunAt: string | null
  createdAt: string
  webhook?: { url: string; secretHint: string }
  mailbox?: { id: string; address: string } | null
}
export type TriggerEvent = { at: string; outcome: 'started' | 'skipped' | 'test'; runId: string | null; detail: Record<string, unknown> }

export const triggersApi = {
  list: (agentId: string) => api<{ triggers: Trigger[] }>('GET', `/agents/${agentId}/triggers`),
  create: (agentId: string, kind: TriggerKind, config: unknown) => api<{ trigger: Trigger }>('POST', `/agents/${agentId}/triggers`, { kind, config }),
  update: (agentId: string, id: string, input: { enabled?: boolean; config?: unknown }) => api<{ trigger: Trigger }>('PATCH', `/agents/${agentId}/triggers/${id}`, input),
  remove: (agentId: string, id: string) => api<void>('DELETE', `/agents/${agentId}/triggers/${id}`),
  reveal: (agentId: string, id: string) => api<{ secret: string; url: string }>('POST', `/agents/${agentId}/triggers/${id}/secret/reveal`),
  rotate: (agentId: string, id: string) => api<{ secret: string; url: string }>('POST', `/agents/${agentId}/triggers/${id}/secret/rotate`),
  events: (agentId: string, id: string) => api<{ events: TriggerEvent[] }>('GET', `/agents/${agentId}/triggers/${id}/events`),
  test: (agentId: string, id: string, payload?: string) => api<{ runId: string }>('POST', `/agents/${agentId}/triggers/${id}/test`, payload === undefined ? {} : { payload }),
}

export const triggerKeys = {
  list: (agentId: string) => ['agents', 'triggers', agentId] as const,
  events: (agentId: string, id: string) => ['agents', 'trigger-events', agentId, id] as const,
}

// ---------------------------------------------------------------------------------------------------------------
// Approvals

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export type Approval = {
  id: string
  agentId: string
  runId: string
  tool: string
  toolLabel: string
  input: Record<string, unknown>
  editedInput: Record<string, unknown> | null
  reason: string
  status: ApprovalStatus
  note: string | null
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
  expiresAt: string
}

export const approvalsApi = {
  list: (agentId: string, status: 'pending' | 'decided' = 'pending') =>
    api<{ approvals: Approval[]; canDecide: boolean }>('GET', `/agents/${agentId}/approvals?status=${status}`),
  decide: (agentId: string, id: string, input: { decision: 'approve' | 'reject'; note?: string; input?: Record<string, unknown> }) =>
    api<{ approval: Approval }>('POST', `/agents/${agentId}/approvals/${encodeURIComponent(id)}`, input),
}

export const approvalKeys = {
  all: (agentId: string) => ['agents', 'approvals', agentId] as const,
  list: (agentId: string, status: 'pending' | 'decided') => ['agents', 'approvals', agentId, status] as const,
}

// ---------------------------------------------------------------------------------------------------------------
// Connectors

export type Condition = { field: string; op: 'gt' | 'lt' | 'eq' | 'contains'; value: string | number }
export type ConnectorAuth = 'none' | 'headers' | 'oauth'
export type ConnectorTool = { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }
export type Connector = {
  id: string
  name: string
  url: string
  auth: ConnectorAuth
  headerNames: string[]
  secretRefs: string[]
  status: 'connected' | 'needs_auth' | 'error'
  statusDetail: string | null
  tools: ConnectorTool[]
  createdAt: string
  checkedAt: string | null
  usedBy: number
}
export type HeaderInput = { name: string; value: string }

export const connectorsApi = {
  list: (orgId: string) => api<{ connectors: Connector[] }>('GET', `/orgs/${orgId}/connectors`),
  create: (orgId: string, input: { name: string; url: string; auth: ConnectorAuth; headers?: HeaderInput[] }) =>
    api<{ connector: Connector; authUrl?: string }>('POST', `/orgs/${orgId}/connectors`, input),
  update: (orgId: string, id: string, input: { name?: string; url?: string; headers?: HeaderInput[] }) =>
    api<{ connector: Connector }>('PATCH', `/orgs/${orgId}/connectors/${id}`, input),
  remove: (orgId: string, id: string) => api<void>('DELETE', `/orgs/${orgId}/connectors/${id}`),
  refresh: (orgId: string, id: string) => api<{ connector: Connector }>('POST', `/orgs/${orgId}/connectors/${id}/refresh`),
  authorize: (orgId: string, id: string) => api<{ connector: Connector; authUrl: string | null }>('POST', `/orgs/${orgId}/connectors/${id}/authorize`),
}

export const connectorKeys = { list: (orgId: string) => ['connectors', orgId] as const }

export const CONDITION_OPS: { op: Condition['op']; label: string }[] = [
  { op: 'gt', label: 'is more than' },
  { op: 'lt', label: 'is less than' },
  { op: 'eq', label: 'is' },
  { op: 'contains', label: 'contains' },
]
