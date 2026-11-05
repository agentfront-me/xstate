// Copies attachments from Stalwart into the organization's R2 bucket and records them in `files`.
//
// Driven by Stalwart's change log, not by the webhook payload: the webhook (or the hourly check) only says
// "this mailbox may have changed". Email/changes since the last saved state then lists every message created
// or destroyed, which also catches deletions (no webhook fires for those) and anything a dropped webhook missed.
// Every step is safe to repeat: an attachment part is claimed in `files` before it is uploaded, so a retried job
// never stores a second copy.

import * as filesDb from '../db/files'
import * as mailboxSyncDb from '../db/mailbox-sync'
import * as mailboxesDb from '../db/mailboxes'
import * as jmap from '../mailserver/stalwart/mail'
import type { JmapAttachmentMessage, JmapBodyPart, JmapFolder } from '../mailserver/stalwart/mail'
import { organizationBucket, type BucketEnv } from './buckets'
import { cleanFileName, fileKey } from './files'
import { deleteObject, putObject } from './r2'

export type SyncEnv = BucketEnv & Pick<Env, 'STALWART_URL' | 'STALWART_API_KEY'>

/** Inline parts smaller than this (signature logos, tracking pixels) aren't worth a file of their own. */
const SMALL_INLINE_BYTES = 20_000
/** Messages fetched per Email/get while copying. */
const BATCH = 50

export type SyncResult = { mailboxId: string; stored: number; skipped: number; deleted: number; firstSync: boolean }

export async function syncMailbox(env: SyncEnv, mailboxId: string): Promise<SyncResult> {
  const result: SyncResult = { mailboxId, stored: 0, skipped: 0, deleted: 0, firstSync: false }
  const mailbox = await mailboxesDb.find(env.DB, mailboxId)
  if (!mailbox) return result // deleted since the job was queued

  const accountId = mailbox.stalwart_id
  const folders = (await jmap.getFolders(env, [accountId])).get(accountId) ?? []
  const ctx = { env, mailbox, accountId, folders, bucket: '' as string, result }
  const since = await mailboxSyncDb.getState(env.DB, mailbox.id)

  if (since) {
    let state = since
    for (;;) {
      const changes = await jmap.emailChanges(env, accountId, state)
      if (!changes) return firstSync(ctx) // state too old to diff from: start over
      await copyMessages(ctx, changes.created)
      if (changes.destroyed.length) {
        const now = new Date().toISOString()
        const { meta } = await filesDb.markDeletedForEmails(env.DB, mailbox.id, changes.destroyed, now).run()
        result.deleted += meta.changes
      }
      state = changes.newState
      await mailboxSyncDb.saveState(env.DB, mailbox.id, state, new Date().toISOString()).run()
      if (!changes.hasMoreChanges) return result
    }
  }
  return firstSync(ctx)
}

type Ctx = {
  env: SyncEnv
  mailbox: mailboxesDb.MailboxRow
  accountId: string
  folders: JmapFolder[]
  bucket: string
  result: SyncResult
}

/**
 * A mailbox seen for the first time (or whose state expired): note the current state, then copy every message
 * that has attachments. Changes after that state are picked up by the next sync.
 */
async function firstSync(ctx: Ctx): Promise<SyncResult> {
  ctx.result.firstSync = true
  const state = (await jmap.getEmailStates(ctx.env, [ctx.accountId])).get(ctx.accountId)!
  for (let position = 0; ; position += BATCH) {
    const page = await jmap.queryEmailsWithAttachments(ctx.env, ctx.accountId, position, BATCH)
    await copyMessages(ctx, page.ids)
    if (position + BATCH >= page.total || !page.ids.length) break
  }
  await mailboxSyncDb.saveState(ctx.env.DB, ctx.mailbox.id, state, new Date().toISOString()).run()
  return ctx.result
}

async function copyMessages(ctx: Ctx, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += BATCH) {
    const messages = await jmap.getAttachmentParts(ctx.env, ctx.accountId, ids.slice(i, i + BATCH))
    for (const message of messages) {
      for (const part of message.attachments) {
        if (!part.blobId || !part.partId) continue
        if ((part.disposition === 'inline' || part.cid) && part.size < SMALL_INLINE_BYTES) {
          ctx.result.skipped++
          continue
        }
        if (await copyPart(ctx, message, part)) ctx.result.stored++
        else ctx.result.skipped++
      }
    }
  }
}

/** Copies one attachment part. Returns false when it was already stored. */
async function copyPart(ctx: Ctx, message: JmapAttachmentMessage, part: JmapBodyPart): Promise<boolean> {
  const { env, mailbox } = ctx
  const existing = await filesDb.findPart(env.DB, mailbox.id, message.id, part.partId!)
  if (existing?.status === 'ready' || existing?.status === 'deleted') return false

  ctx.bucket ||= await organizationBucket(env, mailbox.organization_id)
  const name = cleanFileName(part.name ?? 'attachment')
  const contentType = part.type || 'application/octet-stream'
  const id = existing?.id ?? crypto.randomUUID()
  const key = existing?.r2_key ?? fileKey(mailbox.id, id, name, new Date(message.receivedAt))

  // Claim the part first, so a retry that runs alongside this one sees it and leaves it alone.
  if (!existing) {
    const { meta } = await filesDb
      .insert(env.DB, {
        id,
        organization_id: mailbox.organization_id,
        mailbox_id: mailbox.id,
        r2_key: key,
        name,
        content_type: contentType,
        size_bytes: part.size,
        source: isSent(message, ctx.folders) ? 'sent' : 'received',
        status: 'pending',
        email_id: message.id,
        thread_id: message.threadId,
        part_id: part.partId,
        stalwart_blob_id: part.blobId,
        disposition: part.disposition === 'inline' ? 'inline' : 'attachment',
        content_id: part.cid?.replace(/^<|>$/g, '') ?? null,
        created_by: null,
        created_at: new Date().toISOString(),
      })
      .run()
    if (!meta.changes) return false
  }

  try {
    const download = await jmap.downloadBlob(env, ctx.accountId, part.blobId!, name, contentType)
    const length = Number(download.headers.get('Content-Length') ?? NaN)
    // Hash while streaming to R2, so large attachments are never held in memory.
    const digest = new crypto.DigestStream('SHA-256')
    let size: number
    if (Number.isFinite(length)) {
      const [toR2, toHash] = download.body!.tee()
      const hashing = toHash.pipeTo(digest)
      await putObject(env, ctx.bucket, key, toR2, { contentType, size: length, metadata: { 'file-id': id } })
      await hashing
      size = length
    } else {
      const bytes = new Uint8Array(await download.arrayBuffer())
      const writer = digest.getWriter()
      await writer.write(bytes)
      await writer.close()
      await putObject(env, ctx.bucket, key, bytes, { contentType, metadata: { 'file-id': id } })
      size = bytes.byteLength
    }
    const sha256 = [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    await filesDb.markReady(env.DB, id, size, sha256).run()
    return true
  } catch (err) {
    // Leave nothing half-done: the next sync claims and copies it again.
    await deleteObject(env, ctx.bucket, key).catch(() => null)
    await filesDb.remove(env.DB, id).run()
    throw err
  }
}

function isSent(message: JmapAttachmentMessage, folders: JmapFolder[]): boolean {
  return folders.some((f) => f.role === 'sent' && message.mailboxIds[f.id])
}
