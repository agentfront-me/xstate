// Emptying Trash in mailboxes whose mail the store holds (docs/mailbox-store-plan.md, phase 2 step 2): a message
// that has been in Trash for TRASH_DAYS is deleted for good, its store rows and its raw copy in R2. Runs from the
// hourly cron (jobs/mail-sync.ts); each run takes at most a few hundred messages per mailbox, so a large Trash
// empties over several hours.

import * as mailboxesDb from '../db/mailboxes'
import { organizationBucket, storageConfigured, type BucketEnv } from '../storage/buckets'
import { deleteObject } from '../storage/r2'
import { TRASH_DAYS } from './actions'
import { store } from './stub'

export async function purgeHeldTrash(env: BucketEnv & Pick<Env, 'MAILBOX_STORE'>): Promise<{ mailboxes: number; purged: number }> {
  const result = { mailboxes: 0, purged: 0 }
  if (!storageConfigured(env)) return result
  const before = Math.floor(Date.now() / 1000) - TRASH_DAYS * 24 * 3600
  for (const mailbox of await mailboxesDb.heldByStore(env.DB)) {
    result.mailboxes++
    const { purged, rawKeys } = await (await store(env, mailbox.id)).purgeTrash(before)
    if (!purged) continue
    result.purged += purged
    const bucket = await organizationBucket(env, mailbox.organization_id)
    for (const key of rawKeys) await deleteObject(env, bucket, key).catch((err) => console.error(`trash: deleting ${key} failed`, err))
  }
  return result
}
