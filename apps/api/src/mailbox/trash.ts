// Emptying Trash, and old unsent attachment uploads, in mailboxes whose mail the store holds
// (docs/mailbox-store-plan.md, phase 2 steps 2 and 3): a message that has been in Trash for TRASH_DAYS is deleted for
// good, its store rows and its raw copy in R2, and an upload never sent is deleted after UPLOAD_HOURS. Runs from the
// hourly cron (jobs/hourly.ts); each run takes at most a few hundred messages per mailbox, so a large Trash
// empties over several hours. Delivery-log lines (./delivery-log.ts) older than DELIVERY_LOG_DAYS go in the same pass.

import * as mailboxesDb from '../db/mailboxes'
import { organizationBucket, storageConfigured, type BucketEnv } from '../storage/buckets'
import { deleteObject, listKeys } from '../storage/r2'
import { TRASH_DAYS } from './actions'
import { DELIVERY_LOG_DAYS } from './delivery-log'
import { queueMailEvent } from './events'
import { ulidTime } from './inbound'
import { store } from './stub'

/** Attachments uploaded for a message that was never sent are deleted after this long. */
const UPLOAD_HOURS = 24

export async function purgeHeldTrash(
  env: BucketEnv & Pick<Env, 'MAILBOX_STORE' | 'MAIL_EVENTS'>,
): Promise<{ mailboxes: number; purged: number; uploads: number; logLines: number }> {
  const result = { mailboxes: 0, purged: 0, uploads: 0, logLines: 0 }
  if (!storageConfigured(env)) return result
  const now = Math.floor(Date.now() / 1000)
  const before = now - TRASH_DAYS * 24 * 3600
  for (const mailbox of await mailboxesDb.heldByStore(env.DB)) {
    result.mailboxes++
    const bucket = await organizationBucket(env, mailbox.organization_id)
    const stub = await store(env, mailbox.id)
    const { purged, rawKeys, ids } = await stub.purgeTrash(before)
    result.purged += purged
    // Their files and search documents go too (./events.ts).
    await queueMailEvent(env, { kind: 'removed', mailboxId: mailbox.id, ids })
    for (const key of rawKeys) await deleteObject(env, bucket, key).catch((err) => console.error(`trash: deleting ${key} failed`, err))
    result.uploads += await purgeUploads(env, bucket, mailbox.id)
    result.logLines += await stub.purgeDeliveryLog(now - DELIVERY_LOG_DAYS * 24 * 3600)
    // Calendar apps that last synced over 30 days ago start over (dav/caldav.ts).
    await stub.purgeTombstones(now - 30 * 24 * 3600)
  }
  return result
}

/** Deletes a mailbox's attachment uploads (mailbox/outbound.ts) older than UPLOAD_HOURS: their ULID says when. */
async function purgeUploads(env: BucketEnv, bucket: string, mailboxId: string): Promise<number> {
  const cutoff = Date.now() - UPLOAD_HOURS * 3600_000
  let deleted = 0
  let token: string | undefined
  do {
    const page = await listKeys(env, bucket, `${mailboxId}/uploads/`, token)
    for (const key of page.keys) {
      if (!(ulidTime(key.split('/').pop()!) < cutoff)) continue
      await deleteObject(env, bucket, key).catch((err) => console.error(`uploads: deleting ${key} failed`, err))
      deleted++
    }
    token = page.next ?? undefined
  } while (token)
  return deleted
}
