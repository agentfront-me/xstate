// What starts a run: webhook, schedule and email triggers (docs/agents-plan.md, Phase 2).
//
// Triggers aren't part of the versioned config: a webhook URL stays the same across publishes, and turning one off
// works at once. A trigger fires only while its agent is on and has a published version; the run uses that version
// and acts as the person who published it. When something stops a trigger from starting a run (agent off, a limit,
// the loop guard), it's recorded, so the trigger's recent events and the Runs tab say why nothing happened.

import type { Context } from 'hono'
import { z } from 'zod'
import type { Actor } from '../auth/types'
import * as db from '../db/agents'
import type { TriggerKind, TriggerRow } from '../db/agents'
import * as mailboxesDb from '../db/mailboxes'
import { ApiError } from '../errors'
import { mailboxContext } from '../mailserver/access'
import * as jmap from '../mailserver/stalwart/mail'
import { parseConfig } from './config'
import { emailTask, latestInboxEmail } from './email-trigger'
import type { RunParams } from './run'
import { describe as describeSchedule, nextRun, validate, type ScheduleSpec } from './schedule'
import { seal, unseal } from './seal'
import { webhookTask } from './trigger-text'
import { agentContext, agentMailboxes, blocker, publishedConfig, store } from './service'
import type { AgentStore, StartResult } from './store'

// ---------------------------------------------------------------------------------------------------------------
// Config per kind

export const webhookConfig = z.object({
  name: z.string().trim().min(1).max(80).default('Webhook'),
  /** signature: X-Xstate-Signature HMAC or Authorization: Bearer <secret>. url: the secret is part of the URL, for
   *  services that can't add headers. */
  auth: z.enum(['signature', 'url']).default('signature'),
  /** The run's task. {{payload}} is the whole body; {{order.id}} picks a field. Empty: a default with the payload. */
  template: z.string().max(4000).default(''),
})

export const scheduleConfig = z.object({
  frequency: z.enum(['once', 'interval', 'daily', 'weekly', 'cron']),
  timezone: z.string().min(1).max(64),
  at: z.string().max(16).optional(),
  everyMinutes: z.number().int().optional(),
  time: z.string().max(5).optional(),
  weekdays: z.array(z.number().int()).max(7).optional(),
  cron: z.string().max(100).optional(),
  task: z.string().trim().min(1, 'Write what the agent should do each time').max(4000),
})

export const emailConfig = z.object({
  mailboxId: z.string().min(1).max(64),
  rules: z
    .object({
      /** Sender address or domain contains this (case-insensitive). */
      from: z.string().trim().max(200).default(''),
      subjectContains: z.string().trim().max(200).default(''),
      /** true: only with attachments, false: only without, null: either. */
      hasAttachment: z.boolean().nullable().default(null),
    })
    .default({ from: '', subjectContains: '', hasAttachment: null }),
  /** A condition checked by one model call before the run; empty for none. */
  aiFilter: z.string().trim().max(1000).default(''),
  /** Skip auto-replies, bounces, mailing lists and no-reply senders (on by default: the loop guard). */
  skipAutomated: z.boolean().default(true),
})

export type WebhookConfig = z.output<typeof webhookConfig>
export type ScheduleConfig = z.output<typeof scheduleConfig>
export type EmailConfig = z.output<typeof emailConfig>

const configSchema = { webhook: webhookConfig, schedule: scheduleConfig, email: emailConfig } as const

export type Trigger = {
  id: string
  kind: TriggerKind
  enabled: boolean
  config: WebhookConfig | ScheduleConfig | EmailConfig
  summary: string
  lastFiredAt: string | null
  nextRunAt: string | null
  createdAt: string
  /** Webhook only. The URL never includes the secret here; reveal it to get the full URL in "url" mode. */
  webhook?: { url: string; secretHint: string }
  /** Email only. */
  mailbox?: { id: string; address: string } | null
}

const hookUrl = (env: Env, id: string) => `${env.API_URL.replace(/\/+$/, '')}/hooks/${id}`

async function present(env: Env, row: TriggerRow): Promise<Trigger> {
  const config = configSchema[row.kind].parse(JSON.parse(row.config))
  const base = {
    id: row.id,
    kind: row.kind,
    enabled: !!row.enabled,
    config,
    lastFiredAt: row.last_fired_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  }
  if (row.kind === 'webhook') {
    const c = config as WebhookConfig
    const secret = row.secret_encrypted ? await unseal(env, row.secret_encrypted) : ''
    return {
      ...base,
      summary: `POST ${c.auth === 'url' ? '/hooks/…/<secret>' : `/hooks/${row.id.slice(0, 8)}…`}`,
      webhook: { url: hookUrl(env, row.id), secretHint: secret ? `${secret.slice(0, 6)}…${secret.slice(-4)}` : '' },
    }
  }
  if (row.kind === 'schedule') {
    const c = config as ScheduleConfig
    return { ...base, summary: `${describeSchedule(c)} · ${c.timezone}` }
  }
  const c = config as EmailConfig
  const mailbox = row.mailbox_id ? await mailboxesDb.find(env.DB, row.mailbox_id) : null
  const rules = [c.rules.from && 'from', c.rules.subjectContains && 'subject', c.rules.hasAttachment !== null && 'attachment'].filter(Boolean).length
  return {
    ...base,
    mailbox: mailbox ? { id: mailbox.id, address: mailbox.address } : null,
    summary: `${mailbox?.address ?? 'Mailbox removed'} · ${rules ? `${rules} rule${rules === 1 ? '' : 's'}` : 'all mail'}${c.aiFilter ? ' · AI filter' : ''}`,
  }
}

const newSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return `whsec_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

async function triggerContext(env: Env, actor: Actor, agentId: string, triggerId: string) {
  const agent = await agentContext(env, actor, agentId)
  const trigger = await db.findTrigger(env.DB, triggerId)
  if (!trigger || trigger.agent_id !== agent.id) throw new ApiError('not_found', 'No such trigger', 404)
  return { agent, trigger }
}

function parseKind(kind: TriggerKind, config: unknown) {
  const parsed = configSchema[kind].safeParse(config)
  if (!parsed.success) throw new ApiError('invalid_input', parsed.error.issues[0]?.message ?? 'Invalid trigger settings')
  if (kind === 'schedule') {
    const problem = validate(parsed.data as ScheduleSpec)
    if (problem) throw new ApiError('invalid_input', problem)
  }
  return parsed.data
}

/** Checks the person can read the mailbox and it's in the agent's organization. */
async function checkMailbox(env: Env, actor: Actor, organizationId: string, mailboxId: string) {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'read')
  if (mailbox.organization_id !== organizationId) throw new ApiError('not_found', 'No such mailbox', 404)
  return mailbox
}

/** Works out a schedule trigger's next time and sets the agent's alarm for it. */
async function armSchedule(env: Env, s: Pick<AgentStore, 'armSchedule' | 'disarmSchedule'>, row: TriggerRow) {
  if (row.kind !== 'schedule') return
  if (!row.enabled) {
    await s.disarmSchedule(row.id)
    await db.touchTrigger(env.DB, row.id, { next_run_at: null })
    return
  }
  const spec = scheduleConfig.parse(JSON.parse(row.config))
  const next = nextRun(spec, Date.now(), row.last_fired_at ? Date.parse(row.last_fired_at) : null)
  const at = next === null ? null : new Date(next).toISOString()
  await s.armSchedule(row.id, at)
  await db.touchTrigger(env.DB, row.id, { next_run_at: at })
}

// ---------------------------------------------------------------------------------------------------------------
// Managing triggers (same people who manage the agent)

export async function list(env: Env, actor: Actor, agentId: string): Promise<Trigger[]> {
  const agent = await agentContext(env, actor, agentId)
  return Promise.all((await db.listTriggers(env.DB, agent.id)).map((t) => present(env, t)))
}

export async function create(env: Env, actor: Actor, agentId: string, input: { kind: TriggerKind; config: unknown }): Promise<Trigger> {
  const agent = await agentContext(env, actor, agentId)
  const config = parseKind(input.kind, input.config)
  let mailboxId: string | null = null
  let cursor: string | null = null
  if (input.kind === 'email') {
    const mailbox = await checkMailbox(env, actor, agent.organization_id, (config as EmailConfig).mailboxId)
    mailboxId = mailbox.id
    // Start from now: mail that's already there doesn't fire.
    cursor = (await jmap.getEmailStates(env, [mailbox.stalwart_id])).get(mailbox.stalwart_id) ?? null
  }
  const id = crypto.randomUUID()
  await db.insertTrigger(env.DB, {
    id,
    agentId: agent.id,
    organizationId: agent.organization_id,
    kind: input.kind,
    config: JSON.stringify(config),
    secretEncrypted: input.kind === 'webhook' ? await seal(env, newSecret()) : null,
    mailboxId,
    cursor,
    userId: actor.userId,
    now: new Date().toISOString(),
  })
  const row = (await db.findTrigger(env.DB, id))!
  if (row.kind === 'schedule') await armSchedule(env, await store(env, agent.id), row)
  return present(env, (await db.findTrigger(env.DB, id))!)
}

export async function update(env: Env, actor: Actor, agentId: string, triggerId: string, input: { enabled?: boolean; config?: unknown }): Promise<Trigger> {
  const { agent, trigger } = await triggerContext(env, actor, agentId, triggerId)
  let config: string | undefined
  let mailboxId: string | undefined
  let cursor: string | null | undefined
  if (input.config !== undefined) {
    const parsed = parseKind(trigger.kind, input.config)
    config = JSON.stringify(parsed)
    if (trigger.kind === 'email' && (parsed as EmailConfig).mailboxId !== trigger.mailbox_id) {
      const mailbox = await checkMailbox(env, actor, agent.organization_id, (parsed as EmailConfig).mailboxId)
      mailboxId = mailbox.id
      cursor = (await jmap.getEmailStates(env, [mailbox.stalwart_id])).get(mailbox.stalwart_id) ?? null
    }
  }
  await db.updateTrigger(env.DB, trigger.id, {
    enabled: input.enabled === undefined ? undefined : input.enabled ? 1 : 0,
    config,
    mailbox_id: mailboxId,
    cursor,
  })
  const row = (await db.findTrigger(env.DB, trigger.id))!
  if (row.kind === 'schedule' && (input.config !== undefined || input.enabled !== undefined)) await armSchedule(env, await store(env, agent.id), row)
  return present(env, (await db.findTrigger(env.DB, trigger.id))!)
}

export async function remove(env: Env, actor: Actor, agentId: string, triggerId: string): Promise<void> {
  const { agent, trigger } = await triggerContext(env, actor, agentId, triggerId)
  if (trigger.kind === 'schedule') await (await store(env, agent.id)).disarmSchedule(trigger.id)
  await db.deleteTrigger(env.DB, trigger.id)
}

/** The webhook's secret and full URL (with the secret in it for "url" mode). */
export async function revealSecret(env: Env, actor: Actor, agentId: string, triggerId: string) {
  const { trigger } = await triggerContext(env, actor, agentId, triggerId)
  if (trigger.kind !== 'webhook' || !trigger.secret_encrypted) throw new ApiError('invalid_input', 'Only webhooks have a secret')
  const secret = await unseal(env, trigger.secret_encrypted)
  const auth = webhookConfig.parse(JSON.parse(trigger.config)).auth
  return { secret, url: auth === 'url' ? `${hookUrl(env, trigger.id)}/${secret}` : hookUrl(env, trigger.id) }
}

/** A new webhook secret. The old one stops working at once. */
export async function rotateSecret(env: Env, actor: Actor, agentId: string, triggerId: string) {
  const { trigger } = await triggerContext(env, actor, agentId, triggerId)
  if (trigger.kind !== 'webhook') throw new ApiError('invalid_input', 'Only webhooks have a secret')
  await db.updateTrigger(env.DB, trigger.id, { secret_encrypted: await seal(env, newSecret()) })
  return revealSecret(env, actor, agentId, triggerId)
}

export async function events(env: Env, actor: Actor, agentId: string, triggerId: string) {
  const { agent, trigger } = await triggerContext(env, actor, agentId, triggerId)
  const rows = await (await store(env, agent.id)).triggerEvents(trigger.id, 5)
  return rows.map((e) => ({ at: e.at, outcome: e.outcome, runId: e.run_id, detail: JSON.parse(e.detail) as unknown }))
}

/**
 * Sends a test event through the trigger: a sample webhook payload, the schedule's task now, or the newest email in
 * the mailbox. It runs the agent's draft as a dry run, as the person testing, whether the agent is on or not.
 */
export async function test(env: Env, actor: Actor, agentId: string, triggerId: string, input: { payload?: string }) {
  const { agent, trigger } = await triggerContext(env, actor, agentId, triggerId)
  const draft = parseConfig(agent.draft)
  const problem = await blocker(env, agent.organization_id, draft)
  if (problem) throw new ApiError('not_ready', problem, 409)

  let task: string
  let filter: string | undefined
  let sender: string | undefined
  if (trigger.kind === 'webhook') {
    const c = webhookConfig.parse(JSON.parse(trigger.config))
    task = webhookTask(c, parsePayload(input.payload ?? '{}'))
  } else if (trigger.kind === 'schedule') {
    task = scheduleConfig.parse(JSON.parse(trigger.config)).task
  } else {
    const c = emailConfig.parse(JSON.parse(trigger.config))
    const mailbox = await checkMailbox(env, actor, agent.organization_id, c.mailboxId)
    const email = await latestInboxEmail(env, mailbox)
    if (!email) throw new ApiError('invalid_input', `There's no mail in ${mailbox.address}'s inbox to test with yet`)
    task = emailTask(mailbox, email)
    filter = c.aiFilter || undefined
    sender = email.from?.[0]?.email?.toLowerCase()
  }
  const s = await store(env, agent.id)
  const result = await s.startRun(
    {
      organizationId: agent.organization_id,
      agentId: agent.id,
      version: null,
      actorUserId: actor.userId,
      config: draft,
      task,
      dryRun: true,
      trigger: { kind: trigger.kind, label: `${LABEL[trigger.kind]} test`, triggerId: trigger.id, sender },
      filter,
      mailboxes: await agentMailboxes(env, agent.id, draft),
    },
    draft.limits,
  )
  await s.logTriggerEvent(trigger.id, 'test', result.runId, { task: task.slice(0, 2000) })
  return { runId: result.runId }
}

const LABEL: Record<TriggerKind, string> = { webhook: 'Webhook', schedule: 'Schedule', email: 'Email' }

// ---------------------------------------------------------------------------------------------------------------
// Firing

type FireInput = { task: string; label: string; sender?: string; filter?: string; detail: unknown }
/** The agent's store: a stub (methods return promises) or the store itself. */
type Store = {
  startRun: AgentStore['startRun']
  logTriggerEvent: (...args: Parameters<AgentStore['logTriggerEvent']>) => unknown
}

/**
 * Starts a run of the agent's published version for a trigger, or records why it didn't. `s` is the agent's store:
 * a stub from outside, or the store itself when it's the one firing (schedules).
 */
export async function fire(env: Env, trigger: TriggerRow, s: Store, input: FireInput): Promise<{ outcome: 'started' | 'skipped'; runId?: string; reason?: string }> {
  const skip = async (reason: string) => {
    await s.logTriggerEvent(trigger.id, 'skipped', null, { reason, ...(input.detail as object) })
    return { outcome: 'skipped' as const, reason }
  }
  const agent = await db.findAgent(env.DB, trigger.agent_id)
  if (!agent) return { outcome: 'skipped', reason: 'Agent deleted' }
  if (agent.status !== 'active') return skip('The agent is off')
  const published = await publishedConfig(env, agent)
  if (!published) return skip('The agent has no published version')
  if (!published.publishedBy) return skip('The person who published this version left. Publish it again.')
  const problem = await blocker(env, agent.organization_id, published.config)
  if (problem) return skip(problem)

  const params: Omit<RunParams, 'runId'> = {
    organizationId: agent.organization_id,
    agentId: agent.id,
    version: agent.published_version,
    actorUserId: published.publishedBy,
    config: published.config,
    task: input.task,
    dryRun: false,
    trigger: { kind: trigger.kind, label: input.label, triggerId: trigger.id, sender: input.sender },
    filter: input.filter,
    mailboxes: await agentMailboxes(env, agent.id, published.config),
  }
  const result: StartResult = await s.startRun(params, published.config.limits)
  await db.touchTrigger(env.DB, trigger.id, { last_fired_at: new Date().toISOString() })
  if ('skipped' in result) {
    await s.logTriggerEvent(trigger.id, 'skipped', result.runId, { reason: result.skipped, ...(input.detail as object) })
    return { outcome: 'skipped', runId: result.runId, reason: result.skipped }
  }
  await s.logTriggerEvent(trigger.id, 'started', result.runId, input.detail)
  return { outcome: 'started', runId: result.runId }
}

/** A schedule trigger is due (called inside the agent's store). Arms the next time first, then fires. */
export async function fireSchedule(env: Env, s: AgentStore, triggerId: string) {
  const trigger = await db.findTrigger(env.DB, triggerId)
  if (!trigger || trigger.kind !== 'schedule' || !trigger.enabled) return
  const spec = scheduleConfig.parse(JSON.parse(trigger.config))
  const now = Date.now()
  const next = nextRun(spec, now, now)
  const at = next === null ? null : new Date(next).toISOString()
  await s.armSchedule(trigger.id, at)
  await db.touchTrigger(env.DB, trigger.id, { next_run_at: at })
  await fire(env, trigger, s, { task: spec.task, label: describeSchedule(spec), detail: { due: new Date(now).toISOString() } })
}

// ---------------------------------------------------------------------------------------------------------------
// Webhooks: POST /hooks/:triggerId (and /hooks/:triggerId/:secret in "url" mode). Public, outside /v1.

const MAX_BODY = 256 * 1024

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function same(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y)
}

export async function handleWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env
  const id = c.req.param('triggerId') ?? ''
  const token = c.req.param('token')
  const notFound = () => c.json({ error: { code: 'not_found', message: 'No such webhook' } }, 404)
  if (!/^[\w-]{1,64}$/.test(id)) return notFound()
  const trigger = await db.findTrigger(env.DB, id)
  if (!trigger || trigger.kind !== 'webhook' || !trigger.secret_encrypted) return notFound()

  const { success } = await env.HOOK_RATE.limit({ key: trigger.id })
  if (!success) return c.json({ error: { code: 'rate_limited', message: 'Too many requests to this webhook. Try again in a minute.' } }, 429)
  if (Number(c.req.header('Content-Length') ?? 0) > MAX_BODY) return c.json({ error: { code: 'too_large', message: 'The body can be up to 256 KB' } }, 413)
  const body = await c.req.text()
  if (body.length > MAX_BODY) return c.json({ error: { code: 'too_large', message: 'The body can be up to 256 KB' } }, 413)

  const config = webhookConfig.parse(JSON.parse(trigger.config))
  const secret = await unseal(env, trigger.secret_encrypted)
  const bearer = c.req.header('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  const signature = c.req.header('X-Xstate-Signature')?.replace(/^sha256=/i, '').toLowerCase()
  const authed =
    config.auth === 'url'
      ? !!token && same(token, secret)
      : (!!bearer && same(bearer, secret)) || (!!signature && same(signature, await hmacHex(secret, body)))
  if (!authed) {
    return c.json(
      { error: { code: 'unauthorized', message: config.auth === 'url' ? 'Wrong URL' : 'Sign the body (X-Xstate-Signature: sha256=<hex HMAC>) or send Authorization: Bearer <secret>' } },
      401,
    )
  }
  if (!trigger.enabled) return c.json({ error: { code: 'trigger_off', message: 'This webhook is turned off' } }, 409)

  const payload = parsePayload(body)
  const preview = body.length > 4000 ? `${body.slice(0, 4000)}…` : body
  const result = await fire(env, trigger, await store(env, trigger.agent_id), {
    task: webhookTask(config, payload),
    label: config.name,
    detail: { payload: preview, contentType: c.req.header('Content-Type') ?? null },
  })
  return c.json(result, result.outcome === 'started' ? 202 : 200)
}
