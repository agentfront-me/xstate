// The hourly mail and storage clean-up. Mail arrives through SES into each mailbox's store (mailbox/receive.ts), so
// nothing is synced from a mail server any more; the MAIL_SYNC queue only drains what is left on it until it is
// removed (docs/mailbox-store-plan.md, phase 5b).

import { emptyExpiredTrash } from '../storage/drive'
import { purgeDeletedFiles } from '../storage/purge'
import { purgeHeldTrash } from '../mailbox/trash'
import { DELIVERY_LOG_DAYS } from '../mailbox/delivery-log'
import * as dropsDb from '../db/mail-drops'
import { catchUpHeld } from '../mailbox/events'

export type MailSyncJob = { mailboxId: string; reason: 'webhook' | 'hourly' | 'import' }

/** Queue consumer: acknowledges what is left on the old mail sync queue. */
export async function consume(batch: MessageBatch<MailSyncJob>): Promise<void> {
  for (const message of batch.messages) message.ack()
}

/**
 * Cron, hourly: empty Storage items that have been in the trash for 30 days, permanently remove files deleted more
 * than 30 days ago (including the versions of the items just emptied, which are due straight away), and the mail
 * clean-up below.
 */
export async function hourly(env: Env): Promise<void> {
  const emptied = await emptyExpiredTrash(env)
  if (emptied) console.log('storage-trash', JSON.stringify({ emptied }))
  const purge = await purgeDeletedFiles(env)
  // Messages in Trash for 30 days are deleted for good.
  const trash = await purgeHeldTrash(env).catch((err) => (console.error('store-trash failed', err), null))
  if (trash?.purged || trash?.uploads || trash?.logLines) console.log('store-trash', JSON.stringify(trash))
  // Received mail that reached no mailbox (the delivery log's drops) is kept as long as the log.
  await dropsDb
    .purge(env.DB, new Date(Date.now() - DELIVERY_LOG_DAYS * 24 * 3600_000).toISOString())
    .run()
    .catch((err) => console.error('mail-drops purge failed', err))
  // Mail from before new-mail events existed: filed, indexed (once per mailbox).
  const caught = await catchUpHeld(env).catch((err) => (console.error('mail-events catch-up failed', err), null))
  if (caught?.queued) console.log('mail-events catch-up', JSON.stringify(caught))
  if (purge.purged || purge.failed) console.log('purge', JSON.stringify(purge))
}
