// An agent's config: what the Setup and Settings tabs edit. Stored as JSON in agents.draft and agent_versions.config.
// Parsing fills defaults, so configs saved by older code still load after fields are added.

import { z } from 'zod'

export const PROVIDERS = ['anthropic', 'openai'] as const
export type ProviderId = (typeof PROVIDERS)[number]

export const LIMITS = {
  instructions: 20_000,
  maxSteps: { min: 1, max: 30, default: 12 },
  maxRunsPerDay: { min: 1, max: 10_000, default: 500 },
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
    })
    .default({ builtin: [] }),
  limits: z
    .object({
      maxSteps: z.number().int().min(LIMITS.maxSteps.min).max(LIMITS.maxSteps.max).default(LIMITS.maxSteps.default),
      maxRunsPerDay: z.number().int().min(LIMITS.maxRunsPerDay.min).max(LIMITS.maxRunsPerDay.max).default(LIMITS.maxRunsPerDay.default),
    })
    .default({ maxSteps: LIMITS.maxSteps.default, maxRunsPerDay: LIMITS.maxRunsPerDay.default }),
})

export type AgentConfig = z.output<typeof agentConfig>

export function parseConfig(json: string): AgentConfig {
  return agentConfig.parse(JSON.parse(json))
}

export const defaultConfig = (): AgentConfig => agentConfig.parse({})
