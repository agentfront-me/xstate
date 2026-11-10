// "Describe it" (design: New agent): one model call, with the organization's own key and the model the person
// picked, turns a sentence like "answer refund questions in support@, refunds over $100 need my approval" into a
// draft setup. The model must answer through the propose_agent tool; its answer is checked against the real tool
// catalog and config limits, so the draft can only use what exists. Nothing is saved: the app shows the draft for
// review first.

import { APICallError, generateText, jsonSchema, tool } from 'ai'
import { z } from 'zod'
import type { Actor } from '../auth/types'
import { ApiError } from '../errors'
import { isAdmin, loadMember } from '../mailserver/access'
import { agentConfig, PROVIDERS, type ProviderId } from './config'
import { languageModel } from './model'
import { costOf } from './prices'
import { classify, keyFor, label, reportFailure } from './providers'
import type { AgentDraft, TriggerDraft } from './templates'
import { builtinCatalog } from './tools'

const proposal = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  instructions: z.string().trim().min(1).max(8000),
  tools: z.array(z.string()).max(20).default([]),
  needsApproval: z.array(z.string()).max(20).default([]),
  memory: z.boolean().default(false),
  trigger: z
    .object({
      kind: z.enum(['email', 'schedule', 'webhook', 'none']),
      aiFilter: z.string().max(1000).optional(),
      fromContains: z.string().max(200).optional(),
      subjectContains: z.string().max(200).optional(),
      hasAttachment: z.boolean().nullable().optional(),
      frequency: z.enum(['daily', 'weekly']).optional(),
      time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      task: z.string().max(4000).optional(),
    })
    .default({ kind: 'none' }),
  sampleTask: z.string().max(4000).default(''),
  todo: z.array(z.string().max(300)).max(6).default([]),
})

function prompt(): string {
  const tools = builtinCatalog()
    .map((t) => `- ${t.name}: ${t.description}${t.readOnly ? ' (read only)' : ` (changes things; ${t.defaultApproval === 'always' ? 'needs approval by default' : 'no approval by default'})`}`)
    .join('\n')
  return [
    'You set up AI agents in xstate, a business email app. A person describes what they want; you propose the setup by calling propose_agent once.',
    '',
    'An agent has: instructions it follows on every run (write them in the second person, concrete, step by step, with the tone and limits the person asked for), the built-in tools it may use, which of those need a person’s approval before they run, optional memory between runs, and a trigger that starts it.',
    '',
    'Built-in tools (use only these names):',
    tools,
    '',
    'Pick only the tools the job needs. Tools that send email or create calendar events should need approval unless the person clearly said otherwise. Read-only tools never need approval.',
    'Triggers: "email" (new mail in a mailbox the person picks later; set aiFilter to a one-sentence condition when only some mail matters, and rules for sender, subject or attachments), "schedule" (daily = all 7 days; weekly = only the weekdays listed, 0=Sunday…6=Saturday, so "every weekday" is weekly with [1,2,3,4,5]; at a time HH:MM; with the task for each run), "webhook" (another system posts events), or "none" (run by hand).',
    'Turn memory on when facts about customers or past decisions would help next time.',
    'sampleTask: a realistic input to test it with (an email with From and Subject lines, or the scheduled task).',
    'todo: up to 4 short things the person must fill in or check (an address, a policy, which mailbox). Never invent addresses, prices or policies: put them in todo instead.',
    'If the request is not something an agent with these tools can do, still propose the closest useful setup and explain the gap in todo.',
  ].join('\n')
}

const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short name, like "Refund helper"' },
    description: { type: 'string', description: 'One line: what it does' },
    instructions: { type: 'string' },
    tools: { type: 'array', items: { type: 'string' } },
    needsApproval: { type: 'array', items: { type: 'string' }, description: 'Tools from `tools` that wait for a person' },
    memory: { type: 'boolean' },
    trigger: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['email', 'schedule', 'webhook', 'none'] },
        aiFilter: { type: 'string' },
        fromContains: { type: 'string' },
        subjectContains: { type: 'string' },
        hasAttachment: { type: ['boolean', 'null'] },
        frequency: { type: 'string', enum: ['daily', 'weekly'] },
        time: { type: 'string', description: 'HH:MM, 24-hour' },
        weekdays: { type: 'array', items: { type: 'integer' } },
        task: { type: 'string' },
      },
      required: ['kind'],
    },
    sampleTask: { type: 'string' },
    todo: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'description', 'instructions', 'tools', 'needsApproval', 'memory', 'trigger', 'sampleTask', 'todo'],
}

export async function draft(
  env: Env,
  actor: Actor,
  organizationId: string,
  input: { prompt: string; model: { provider: ProviderId; id: string } },
): Promise<AgentDraft & { cost: number }> {
  const member = await loadMember(env, organizationId, actor.userId)
  if (!isAdmin(member) && !member.permissions.org.includes('agents.manage')) {
    throw new ApiError('forbidden', 'Only owners, admins and people with the agents permission can manage agents', 403)
  }
  if (!PROVIDERS.includes(input.model.provider)) throw new ApiError('invalid_input', 'Unknown provider')
  const key = await keyFor(env, organizationId, input.model.provider)
  if ('error' in key) throw new ApiError('not_ready', key.error, 409)

  const tools = { propose_agent: tool({ description: 'Propose the agent’s setup.', inputSchema: jsonSchema(PROPOSE_SCHEMA as never) }) }
  let result: Awaited<ReturnType<typeof generateText<typeof tools>>>
  try {
    result = await generateText({
      model: await languageModel(env, input.model.provider, input.model.id, key.key),
      instructions: prompt(),
      messages: [{ role: 'user', content: input.prompt }],
      tools,
      toolChoice: { type: 'tool', toolName: 'propose_agent' },
      maxRetries: 1,
    })
  } catch (err) {
    if (APICallError.isInstance(err) && err.statusCode) {
      const failure = classify(input.model.provider, err.statusCode, err.responseBody ?? '')
      if (failure.status !== 'valid') await reportFailure(env, organizationId, input.model.provider, failure.status, failure.detail)
      throw new ApiError('provider_error', failure.status === 'valid' ? `${label(input.model.provider)}: ${err.message}` : failure.detail, 502)
    }
    throw err
  }
  const call = result.toolCalls.find((c) => c.toolName === 'propose_agent')
  const parsed = proposal.safeParse(call?.input)
  if (!parsed.success) throw new ApiError('draft_failed', 'The model didn’t come back with a usable setup. Try again, or describe it differently.', 502)
  const p = parsed.data

  // Only real tools; approval only for tools that change things.
  const catalog = builtinCatalog()
  const chosen = [...new Set(p.tools)].filter((n) => catalog.some((t) => t.name === n))
  const approval: Record<string, 'always' | 'never'> = {}
  for (const name of chosen) {
    const t = catalog.find((x) => x.name === name)!
    if (t.readOnly) continue
    approval[name] = p.needsApproval.includes(name) ? 'always' : 'never'
  }
  const config = agentConfig.parse({
    instructions: p.instructions,
    model: input.model,
    tools: { builtin: chosen, approval },
    memory: { enabled: p.memory },
  })
  const usage = { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0 }
  return {
    template: null,
    name: p.name,
    description: p.description,
    config,
    trigger: triggerDraft(p.trigger),
    sampleTask: p.sampleTask,
    todo: p.todo,
    cost: costOf(input.model.provider, input.model.id, usage),
  }
}

function triggerDraft(t: z.output<typeof proposal>['trigger']): TriggerDraft | null {
  if (t.kind === 'email') {
    return {
      kind: 'email',
      config: { rules: { from: t.fromContains ?? '', subjectContains: t.subjectContains ?? '', hasAttachment: t.hasAttachment ?? null }, aiFilter: t.aiFilter ?? '' },
    }
  }
  if (t.kind === 'schedule') {
    // Specific days only make sense weekly, whatever the model called it.
    const frequency = t.weekdays?.length && t.weekdays.length < 7 ? 'weekly' : (t.frequency ?? 'weekly')
    return {
      kind: 'schedule',
      config: { frequency, time: t.time ?? '09:00', ...(frequency === 'weekly' && { weekdays: t.weekdays?.length ? t.weekdays : [1] }), task: t.task?.trim() || 'Do your job for this period.' },
    }
  }
  if (t.kind === 'webhook') return { kind: 'webhook', config: { name: 'Webhook', template: '' } }
  return null
}
