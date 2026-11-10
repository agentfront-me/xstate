// Email triggers. Inbound mail arrives through Stalwart, not Cloudflare Email Routing, so this rides on mail sync:
// whenever a mailbox is synced (Stalwart's webhook on new mail, and the hourly safety check), its email triggers look
// at what changed since their own saved JMAP state. Each new message in the inbox fires each matching trigger once.
//
// The loop guard (skipAutomated, on by default) skips auto-replies, bounces, mailing lists and no-reply senders, and
// mail the mailbox sent itself, so two automated senders can't keep each other going. The per-sender hourly limit and
// the daily limit are applied when the run starts (agents/store.ts).

import * as db from '../db/agents'
import type { TriggerRow } from '../db/agents'
import * as mailboxesDb from '../db/mailboxes'
import type { MailboxRow } from '../db/mailboxes'
import * as jmap from '../mailserver/stalwart/mail'
import type { TriggerEmail } from '../mailserver/stalwart/mail'
import { store } from './service'
import { automated, emailTask, matchesRules } from './trigger-text'
import { emailConfig, fire, type EmailConfig } from './triggers'

/** New messages handled per trigger per sync; a flood past this is skipped (it'd hit the hourly limits anyway). */
const MAX_NEW = 50

async function inboxId(env: Env, accountId: string): Promise<string | null> {
  const folders = (await jmap.getFolders(env, [accountId])).get(accountId) ?? []
  return folders.find((f) => f.role === 'inbox')?.id ?? null
}

export { emailTask }

/** The newest message in a mailbox's inbox, for a trigger's test event. */
export async function latestInboxEmail(env: Env, mailbox: MailboxRow): Promise<TriggerEmail | null> {
  const inbox = await inboxId(env, mailbox.stalwart_id)
  if (!inbox) return null
  const [id] = await jmap.newestIn(env, mailbox.stalwart_id, inbox, 1)
  if (!id) return null
  return (await jmap.getTriggerEmails(env, mailbox.stalwart_id, [id]))[0] ?? null
}

/** What changed in the account since `state`: created message ids and the new state (null: start over from now). */
async function createdSince(env: Env, accountId: string, state: string): Promise<{ created: string[]; state: string } | null> {
  const created: string[] = []
  let current = state
  for (let i = 0; i < 20; i++) {
    const changes = await jmap.emailChanges(env, accountId, current, 200)
    if (!changes) return null
    created.push(...changes.created)
    current = changes.newState
    if (!changes.hasMoreChanges) break
  }
  return { created, state: current }
}

/** Runs a mailbox's email triggers on its new mail. Called by the mail sync queue consumer for every synced mailbox. */
export async function processMailbox(env: Env, mailboxId: string): Promise<{ fired: number; skipped: number }> {
  const triggers = await db.emailTriggersFor(env.DB, mailboxId)
  const result = { fired: 0, skipped: 0 }
  if (!triggers.length) return result
  const mailbox = await mailboxesDb.find(env.DB, mailboxId)
  if (!mailbox) return result
  const accountId = mailbox.stalwart_id

  // One change walk per distinct saved state (usually all triggers share the latest one).
  const walks = new Map<string, Awaited<ReturnType<typeof createdSince>>>()
  for (const t of triggers) {
    if (t.cursor && !walks.has(t.cursor)) walks.set(t.cursor, await createdSince(env, accountId, t.cursor))
  }
  const ids = [...new Set([...walks.values()].flatMap((w) => w?.created ?? []))]
  const inbox = ids.length ? await inboxId(env, accountId) : null
  const emails = new Map((ids.length ? await jmap.getTriggerEmails(env, accountId, ids.slice(-500)) : []).map((e) => [e.id, e]))
  let fresh: string | null = null
  const now = async () => (fresh ??= (await jmap.getEmailStates(env, [accountId])).get(accountId) ?? '')

  for (const trigger of triggers) {
    const walk = trigger.cursor ? walks.get(trigger.cursor) : null
    // No saved state yet, or too old to diff from: start from now without firing.
    if (!walk) {
      await db.touchTrigger(env.DB, trigger.id, { cursor: await now() })
      continue
    }
    const config = emailConfig.parse(JSON.parse(trigger.config))
    // Saved before firing: a crash mid-way skips some mail rather than replying twice.
    await db.touchTrigger(env.DB, trigger.id, { cursor: walk.state })
    const incoming = walk.created
      .map((id) => emails.get(id))
      .filter((e): e is TriggerEmail => !!e && !!inbox && !!e.mailboxIds[inbox] && !e.keywords.$draft)
      .slice(0, MAX_NEW)
    const s = incoming.length ? await store(env, trigger.agent_id) : null
    for (const email of incoming) {
      const outcome = await fireForEmail(env, trigger, s!, mailbox, config, email)
      if (outcome === 'started') result.fired++
      else if (outcome === 'skipped') result.skipped++
    }
  }
  return result
}

async function fireForEmail(
  env: Env,
  trigger: TriggerRow,
  s: Awaited<ReturnType<typeof store>>,
  mailbox: MailboxRow,
  config: EmailConfig,
  email: TriggerEmail,
): Promise<'started' | 'skipped' | 'ignored'> {
  if (!matchesRules(config.rules, email)) return 'ignored'
  const sender = email.from?.[0]?.email?.toLowerCase() ?? ''
  const detail = { from: sender, subject: email.subject, emailId: email.id }
  const label = `Email from ${sender || 'unknown'}`
  if (config.skipAutomated) {
    const own = [mailbox.address, ...(JSON.parse(mailbox.aliases || '[]') as string[])].map((a) => a.toLowerCase())
    const reason = own.includes(sender) ? 'Sent by this mailbox' : automated(email)
    if (reason) {
      // Kept in the trigger's recent events (not as a run, so newsletters don't flood the Runs tab).
      await s.logTriggerEvent(trigger.id, 'skipped', null, { reason: `Loop guard: ${reason}`, ...detail })
      return 'skipped'
    }
  }
  const result = await fire(env, trigger, s, { task: emailTask(mailbox, email), label, sender, filter: config.aiFilter || undefined, detail })
  return result.outcome
}
