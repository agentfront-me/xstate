// An agent's config: what the Setup and Settings tabs edit. Stored as JSON in agents.draft and agent_versions.config.
// Parsing fills defaults, so configs saved by older code still load after fields are added.

import { z } from 'zod'

export const PROVIDERS = ['anthropic', 'openai'] as const
export type ProviderId = (typeof PROVIDERS)[number]

export const LIMITS = {
  instructions: 20_000,
  maxSteps: { min: 1, max: 30, default: 12 },
  maxRunsPerDay: { min: 1, max: 10_000, default: 500 },
  perSenderPerHour: { min: 1, max: 1000, default: 10 },
  monthlyCapUsd: { min: 1, max: 100_000 },
  retentionDays: { min: 1, max: 3650, default: 90 },
}

export const agentConfig = z.object({
  instructions: z.string().max(LIMITS.instructions).default(''),
  /** Null until a model is picked. Runs and publishing need one. */
  model: z
    .object({ provider: z.enum(PROVIDERS), id: z.string().min(1).max(100) })
    .nullable()
    .default(null),
  tools: z
    .object({
      /** Built-in tool names (agents/tools.ts) the agent may use. Unknown names are ignored. */
      builtin: z.array(z.string().max(64)).max(50).default([]),
      /**
       * Per tool: does a call wait for a person? Tools not listed use their default (agents/tools.ts: sending and
       * invitations ask, drafts and moving mail don't). Read-only tools never ask.
       */
      approval: z.record(z.string().max(200), z.enum(['always', 'never', 'when'])).default({}),
      /** Connector tools the agent may use: connector id → tool names (agents/connectors.ts). */
      connectors: z.record(z.string().max(64), z.array(z.string().max(128)).max(200)).default({}),
      /**
       * For tools set to "when": the call needs approval only if its input matches, e.g. amount > 100. Keys are the
       * same as in `approval` (built-in tool name, or "<connector id>/<tool>").
       */
      conditions: z
        .record(
          z.string().max(200),
          z.object({ field: z.string().min(1).max(100), op: z.enum(['gt', 'lt', 'eq', 'contains']), value: z.union([z.string().max(200), z.number()]) }),
        )
        .default({}),
    })
    .default({ builtin: [], approval: {}, connectors: {}, conditions: {} }),
  /**
   * Mailboxes the agent may read and act in (mailbox ids). The mailboxes its email triggers watch are added at run
   * time. Every tool call that names a mailbox must name one of these.
   */
  mailboxes: z.array(z.string().max(64)).max(50).default([]),
  approvals: z
    .object({
      /** Hours a call waits for a decision. */
      timeoutHours: z.number().int().min(1).max(168).default(24),
      /** reject: the call is refused after timeoutHours. wait: keep waiting, up to 7 days. */
      onTimeout: z.enum(['reject', 'wait']).default('reject'),
      /** User ids who can decide. Empty: anyone who can manage agents. Owners and admins always can. */
      approvers: z.array(z.string().max(64)).max(50).default([]),
      /** Email the approvers when a call is waiting. */
      notifyEmail: z.boolean().default(true),
    })
    .default({ timeoutHours: 24, onTimeout: 'reject', approvers: [], notifyEmail: true }),
  limits: z
    .object({
      maxSteps: z.number().int().min(LIMITS.maxSteps.min).max(LIMITS.maxSteps.max).default(LIMITS.maxSteps.default),
      maxRunsPerDay: z.number().int().min(LIMITS.maxRunsPerDay.min).max(LIMITS.maxRunsPerDay.max).default(LIMITS.maxRunsPerDay.default),
      /** Runs one email sender can start in an hour, so one person can't use up the organization's AI credit. */
      perSenderPerHour: z
        .number()
        .int()
        .min(LIMITS.perSenderPerHour.min)
        .max(LIMITS.perSenderPerHour.max)
        .default(LIMITS.perSenderPerHour.default),
    })
    .default({ maxSteps: LIMITS.maxSteps.default, maxRunsPerDay: LIMITS.maxRunsPerDay.default, perSenderPerHour: LIMITS.perSenderPerHour.default }),
  /**
   * Estimated AI spend per calendar month (UTC), from token counts and our price table (agents/prices.ts). Null: no
   * cap. pause: runs are skipped until next month or a higher cap. notify: keep running, tell the admins once.
   */
  spend: z
    .object({
      monthlyCapUsd: z.number().min(LIMITS.monthlyCapUsd.min).max(LIMITS.monthlyCapUsd.max).nullable().default(null),
      whenReached: z.enum(['pause', 'notify']).default('pause'),
    })
    .default({ monthlyCapUsd: null, whenReached: 'pause' }),
  /**
   * Facts the agent keeps between runs (remember / recall tools), stored in its Durable Object. Off by default.
   * retentionDays: facts not updated for this long are deleted; null keeps them until someone deletes them.
   */
  memory: z
    .object({
      enabled: z.boolean().default(false),
      retentionDays: z.number().int().min(LIMITS.retentionDays.min).max(LIMITS.retentionDays.max).nullable().default(LIMITS.retentionDays.default),
    })
    .default({ enabled: false, retentionDays: LIMITS.retentionDays.default }),
})

export type AgentConfig = z.output<typeof agentConfig>

export function parseConfig(json: string): AgentConfig {
  return agentConfig.parse(JSON.parse(json))
}

export const defaultConfig = (): AgentConfig => agentConfig.parse({})
