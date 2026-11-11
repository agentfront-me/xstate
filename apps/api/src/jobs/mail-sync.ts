// Background mail sync: Stalwart's webhook and the hourly safety check both put "sync this mailbox" jobs on the
// MAIL_SYNC queue; the consumer runs storage/mail-sync for each. See docs/message-api-plan.md.

import { processMailbox } from '../agents/email-trigger'
import * as mailboxesDb from '../db/mailboxes'
import { scannerHealth } from '../security/scan'
import { syncMailbox } from '../storage/mail-sync'
import { emptyExpiredTrash } from '../storage/drive'
import { purgeDeletedFiles } from '../storage/purge'
import { notifyNewMail } from '../push/new-mail'
import { announce } from '../live/announce'
import * as accessDb from '../db/mailbox-access'

export type MailSyncJob = { mailboxId: string; reason: 'webhook' | 'hourly' | 'import' }

export async function enqueue(env: Pick<Env, 'MAIL_SYNC'>, jobs: MailSyncJob[]): Promise<void> {
  // sendBatch takes up to 100 messages.
  for (let i = 0; i < jobs.length; i += 100) {
    await env.MAIL_SYNC.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })))
  }
}

/** Queue consumer. A mailbox queued several times in one batch is synced once. */
export async function consume(batch: MessageBatch<MailSyncJob>, env: Env): Promise<void> {
  const byMailbox = new Map<string, Message<MailSyncJob>[]>()
  for (const message of batch.messages) {
    const list = byMailbox.get(message.body.mailboxId) ?? []
    list.push(message)
    byMailbox.set(message.body.mailboxId, list)
  }
  for (const [mailboxId, messages] of byMailbox) {
    // Agents' email triggers first, on their own: a storage sync failure mustn't hold up replies, nor the other way.
    try {
      const agents = await processMailbox(env, mailboxId)
      if (agents.fired || agents.skipped) console.log('agent-email-triggers', JSON.stringify({ mailboxId, ...agents }))
    } catch (err) {
      console.error(`agent-email-triggers: mailbox ${mailboxId} failed`, err)
    }
    // "New email" on people's phones, also on its own. Not for an import's sync: that mail is old.
    if (messages.some((m) => m.body.reason !== 'import')) {
      try {
        const pushed = await notifyNewMail(env, mailboxId)
        if (pushed.notified) console.log('new-mail-push', JSON.stringify({ mailboxId, ...pushed }))
      } catch (err) {
        console.error(`new-mail-push: mailbox ${mailboxId} failed`, err)
      }
    }
    try {
      const result = await syncMailbox(env, mailboxId)
      if (result.stored || result.deleted || result.queued || result.unindexed || result.firstSync) console.log('mail-sync', JSON.stringify(result))
      for (const m of messages) m.ack()
      // The mobile app reloads this mailbox for whoever has it open. Not for the hourly check, which syncs every mailbox
      // whether or not anything arrived.
      if (messages.some((m) => m.body.reason === 'webhook')) await announceMailbox(env, mailboxId)
    } catch (err) {
      console.error(`mail-sync: mailbox ${mailboxId} failed`, err)
      // Retried with backoff; the sync picks up from its last saved state.
      for (const m of messages) m.retry({ delaySeconds: 30 * m.attempts })
    }
  }
}

/** Tells the people who can open the mailbox, if any of them has the app open. */
async function announceMailbox(env: Env, mailboxId: string): Promise<void> {
  try {
    const mailbox = await mailboxesDb.find(env.DB, mailboxId)
    if (!mailbox) return
    const userIds = (await accessDb.list(env.DB, mailboxId)).map((a) => a.user_id)
    if (userIds.length) await announce(env, mailbox.organization_id, { type: 'mail', mailboxId }, userIds)
  } catch (err) {
    console.warn(`live: mailbox ${mailboxId} failed`, err)
  }
}

/**
 * Cron, hourly: queue every mailbox in case webhooks were lost (mailboxes with nothing new finish in one JMAP call),
 * empty Storage items that have been in the trash for 30 days, and permanently remove files deleted more than 30 days
 * ago (including the versions of the items just emptied, which are due straight away).
 */
export async function hourly(env: Env): Promise<void> {
  const ids = await mailboxesDb.allIds(env.DB)
  await enqueue(env, ids.map((mailboxId) => ({ mailboxId, reason: 'hourly' })))
  const emptied = await emptyExpiredTrash(env)
  if (emptied) console.log('storage-trash', JSON.stringify({ emptied }))
  const purge = await purgeDeletedFiles(env)
  if (purge.purged || purge.failed) console.log('purge', JSON.stringify(purge))
  // The virus scanner on the mail server: down, or its signatures have stopped updating.
  const scanner = await scannerHealth(env)
  if (scanner && !scanner.ok) console.error('scanner-unhealthy', scanner.detail)
}
