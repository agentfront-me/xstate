// The agents_*, ai_providers_* and secrets_* API (apps/api/src/operations/agents.ts).

import { api } from '../lib/core'

export type ProviderId = 'anthropic' | 'openai'
export type ProviderStatus = 'valid' | 'invalid' | 'no_credit' | 'rate_limited'

export type AgentConfig = {
  instructions: string
  model: { provider: ProviderId; id: string } | null
  tools: { builtin: string[] }
  limits: { maxSteps: number; maxRunsPerDay: number; perSenderPerHour: number }
}

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

export type Agent = AgentSummary & { draft: AgentConfig; published: AgentConfig | null }

export type ToolInfo = { name: string; label: string; group: string; description: string; readOnly: boolean }
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
  summary: string | null
  error: string | null
}

export type RunStep =
  | { seq: number; at: string; kind: 'model'; detail: { text: string; calls: { toolName: string; input: unknown }[]; tokens: { input: number; output: number } } }
  | { seq: number; at: string; kind: 'tool'; detail: { tool: string; input: unknown; output: unknown } }
  | { seq: number; at: string; kind: string; detail: Record<string, unknown> }

export type Stats = { runs7d: number; successRate: number | null; tokens7d: number; month: { model: string; input: number; output: number; runs: number }[] }
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
