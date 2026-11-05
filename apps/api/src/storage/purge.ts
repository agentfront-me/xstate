// Permanently removes files whose message was deleted more than GRACE_DAYS ago: the R2 object first, then the row.
// Until then a deleted file stays in R2 (status 'deleted'), so a mistaken delete can still be recovered by hand.
// Runs from the hourly cron, a capped batch at a time; a backlog clears over the following hours.

import * as filesDb from '../db/files'
import type { R2Env } from './r2'
import { deleteObject } from './r2'

export const GRACE_DAYS = 30
const BATCH = 500

export type PurgeResult = { purged: number; failed: number }

export async function purgeDeletedFiles(env: R2Env & Pick<Env, 'DB'>, now = new Date()): Promise<PurgeResult> {
  const before = new Date(now.getTime() - GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const rows = await filesDb.listPurgeable(env.DB, before, BATCH)
  const done: string[] = []
  let failed = 0

  // A few at a time; R2 doesn't rate-limit deletes of different keys.
  for (let i = 0; i < rows.length; i += 25) {
    await Promise.all(
      rows.slice(i, i + 25).map(async (row) => {
        try {
          // No bucket means the object was never stored there; deleting a missing key also succeeds.
          if (row.bucket) await deleteObject(env, row.bucket, row.r2_key)
          done.push(row.id)
        } catch (err) {
          failed++
          console.error(`purge: deleting ${row.bucket}/${row.r2_key} failed`, err)
        }
      }),
    )
  }
  // Only rows whose object is gone; failures stay 'deleted' and are retried next hour.
  if (done.length) await filesDb.removeMany(env.DB, done).run()
  return { purged: done.length, failed }
}
