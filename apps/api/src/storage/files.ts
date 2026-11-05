// Where files go in R2 and keeping R2 in step with mailboxes. Layout, inside the organization's bucket:
//   <mailbox id>/<yyyy>/<mm>/<file id>/<file name>
// The folder is the mailbox id, not its address, because addresses can be renamed. The file id keeps two files
// with the same name apart.

import * as organizationsDb from '../db/organizations'
import { deletePrefix } from './r2'
import type { BucketEnv } from './buckets'

/** Turns a name from an email or an upload into one that is safe as the last part of a key and for download. */
export function cleanFileName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    // Path separators and control characters would change the key's meaning or break headers.
    .replace(/[/\\\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180)
  return cleaned || 'attachment'
}

export function fileKey(mailboxId: string, fileId: string, name: string, date = new Date()): string {
  const yyyy = String(date.getUTCFullYear())
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${mailboxId}/${yyyy}/${mm}/${fileId}/${cleanFileName(name)}`
}

/**
 * Deletes a mailbox's folder from the organization's bucket. Called before the mailbox row goes (its files rows
 * cascade with it). An organization with no bucket yet has nothing to delete.
 */
export async function deleteMailboxFolder(env: BucketEnv, organizationId: string, mailboxId: string): Promise<number> {
  const bucket = await organizationsDb.getBucket(env.DB, organizationId)
  if (!bucket) return 0
  return deletePrefix(env, bucket, `${mailboxId}/`)
}
