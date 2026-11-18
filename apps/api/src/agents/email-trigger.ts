// Email triggers. Each new message delivered into a mailbox's inbox (mailbox/events.ts) is offered to the mailbox's
// email triggers, and fires each matching one once.
//
// The loop guard (skipAutomated, on by default) skips auto-replies, bounces, mailing lists and no-reply senders, and
// mail the mailbox sent itself, so two automated senders can't keep each other going. The per-sender hourly limit and
// the daily limit are applied when the run starts (agents/store.ts).

import * as db from '../db/agents'
import type { TriggerRow } from '../db/agents'
import type { MailboxRow } from '../db/mailboxes'
import type { TriggerEmail } from '../mailbox/trigger-email'
import { parseRaw } from '../mailbox/parse'
import { store as mailboxStore } from '../mailbox/stub'
import { triggerEmailOf } from '../mailbox/trigger-email'
import { organizationBucket } from '../storage/buckets'
import { getObject } from '../storage/r2'
import { store } from './service'
import { automated, emailTask, matchesRules } from './trigger-text'
import { emailConfig, fire, type EmailConfig } from './triggers'

export { emailTask }

/** The newest message in a mailbox's inbox, for a trigger's test event, read the way new mail is (mailbox/events.ts). */
export async function latestInboxEmail(env: Env, mailbox: MailboxRow): Promise<TriggerEmail | null> {
  const stub = await mailboxStore(env, mailbox.id)
  const top = (await stub.list({ folder: 'inbox', limit: 1 })).messages[0]
  if (!top) return null
  const [row] = await stub.rows([top.id])
  if (!row?.rawKey) return null
  const res = await getObject(env, await organizationBucket(env, mailbox.organization_id), row.rawKey)
  if (!res) return null
  const parsed = await parseRaw(new Uint8Array(await res.arrayBuffer()))
  return triggerEmailOf({ ...row, to: parsed.to, cc: parsed.cc, text: parsed.text, headers: parsed.headers })
}

/**
 * Offers one new message (mailbox/events.ts) to the mailbox's email triggers: their rules, loop guard and AI filter.
 * Each trigger claims the message first in its agent's store, so a retried event never starts a second run.
 */
export async function offerStoredEmail(env: Env, mailbox: MailboxRow, email: TriggerEmail): Promise<{ fired: number; skipped: number }> {
  const result = { fired: 0, skipped: 0 }
  for (const trigger of await db.emailTriggersFor(env.DB, mailbox.id)) {
    const s = await store(env, trigger.agent_id)
    if (!(await s.claimTriggerEmail(trigger.id, mailbox.id, email.id))) continue
    const config = emailConfig.parse(JSON.parse(trigger.config))
    const outcome = await fireForEmail(env, trigger, s, mailbox, config, email)
    if (outcome === 'started') result.fired++
    else if (outcome === 'skipped') result.skipped++
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
