// Background mail sync: Stalwart's webhook and the hourly safety check both put "sync this mailbox" jobs on the
// MAIL_SYNC queue; the consumer runs storage/mail-sync for each. See docs/message-api-plan.md.

import * as mailboxesDb from '../db/mailboxes'
import { syncMailbox } from '../storage/mail-sync'
import { purgeDeletedFiles } from '../storage/purge'

export type MailSyncJob = { mailboxId: string; reason: 'webhook' | 'hourly' }

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
    try {
      const result = await syncMailbox(env, mailboxId)
      if (result.stored || result.deleted || result.firstSync) console.log('mail-sync', JSON.stringify(result))
      for (const m of messages) m.ack()
    } catch (err) {
      console.error(`mail-sync: mailbox ${mailboxId} failed`, err)
      // Retried with backoff; the sync picks up from its last saved state.
      for (const m of messages) m.retry({ delaySeconds: 30 * m.attempts })
    }
  }
}

/**
 * Cron, hourly: queue every mailbox in case webhooks were lost (mailboxes with nothing new finish in one JMAP call),
 * and permanently remove files deleted more than 30 days ago.
 */
export async function hourly(env: Env): Promise<void> {
  const ids = await mailboxesDb.allIds(env.DB)
  await enqueue(env, ids.map((mailboxId) => ({ mailboxId, reason: 'hourly' })))
  const purge = await purgeDeletedFiles(env)
  if (purge.purged || purge.failed) console.log('purge', JSON.stringify(purge))
}
