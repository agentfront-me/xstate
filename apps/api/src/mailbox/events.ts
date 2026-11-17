// New-mail events for mailboxes whose mail the store holds (docs/mailbox-store-plan.md, phase 2 step 4a). What
// mail sync (jobs/mail-sync.ts) does for Stalwart mail by walking its change log, these do from events the store's
// writers queue on MAIL_EVENTS: attachments filed in `files`, messages indexed for search, received mail offered to
// agents' email triggers, and their removal when messages go. On a queue of their own, so delivery never waits for
// or retries because of the model or Vectorize. Every step is safe to repeat.

import * as filesDb from '../db/files'
import * as mailboxesDb from '../db/mailboxes'
import type { MailboxRow } from '../db/mailboxes'
import { offerStoredEmail } from '../agents/email-trigger'
import { refreshEmailFolders, removeEmails } from '../search/indexer'
import { enqueueEmails, enqueueIndex } from '../search/jobs'
import { encodeSafety, inspectStream } from '../security/attachments'
import { organizationBucket } from '../storage/buckets'
import { cleanFileName, fileKey } from '../storage/files'
import { deleteObject, getObject, putObject } from '../storage/r2'
import { decodePart } from './mime'
import { fileParts, parseRaw, partName, type ParsedMessage } from './parse'
import type { StoreEventRow } from './store'
import { store } from './stub'
import { triggerEmailOf } from './trigger-email'

/**
 * A change to messages of one store-held mailbox. `direction` says whether `new` mail came in or was sent;
 * `offer: false` keeps received mail from agents (old mail caught up, which agents shouldn't answer now).
 */
export type MailEvent =
  | { kind: 'new'; mailboxId: string; ids: string[]; direction: 'in' | 'out'; offer?: boolean }
  | { kind: 'moved' | 'removed'; mailboxId: string; ids: string[] }

/** Messages per event: a `new` event reads each message's raw copy. */
const PER_EVENT = 10
/** Inline parts smaller than this (signature logos, tracking pixels) aren't filed, as for Stalwart mail. */
const SMALL_INLINE_BYTES = 20_000

/** Queues an event, split so each job stays small. Never fails the caller: a lost event is logged. */
export async function queueMailEvent(env: Pick<Env, 'MAIL_EVENTS'>, event: MailEvent): Promise<void> {
  if (!event.ids.length) return
  const jobs: MailEvent[] = []
  for (let i = 0; i < event.ids.length; i += PER_EVENT) jobs.push({ ...event, ids: event.ids.slice(i, i + PER_EVENT) })
  try {
    for (let i = 0; i < jobs.length; i += 100) await env.MAIL_EVENTS.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })))
  } catch (err) {
    console.error('mail-events: queueing failed', JSON.stringify({ kind: event.kind, mailboxId: event.mailboxId, ids: event.ids.length }), err)
  }
}

export async function consumeMailEvents(batch: MessageBatch<MailEvent>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const result = await handle(env, message.body)
      if (result) console.log('mail-events', JSON.stringify(result))
      message.ack()
    } catch (err) {
      console.error(`mail-events: ${message.body.kind} for ${message.body.mailboxId} failed (attempt ${message.attempts})`, err)
      message.retry({ delaySeconds: Math.min(30 * message.attempts, 600) })
    }
  }
}

async function handle(env: Env, event: MailEvent) {
  const mailbox = await mailboxesDb.find(env.DB, event.mailboxId)
  if (!mailbox || mailbox.backend !== 'store') return null
  if (event.kind === 'moved') return { kind: event.kind, mailboxId: mailbox.id, moved: await refreshEmailFolders(env, mailbox.id, event.ids) }
  if (event.kind === 'removed') {
    const { meta } = await filesDb.markDeletedForEmails(env.DB, mailbox.id, event.ids, new Date().toISOString()).run()
    return { kind: event.kind, mailboxId: mailbox.id, files: meta.changes, unindexed: await removeEmails(env, mailbox.id, event.ids) }
  }

  const fresh = event as Extract<MailEvent, { kind: 'new' }>
  const result = { kind: event.kind, mailboxId: mailbox.id, messages: 0, filed: 0, blocked: 0, fired: 0, skipped: 0 }
  const rows = await (await store(env, mailbox.id)).rows(event.ids)
  const bucket = await organizationBucket(env, mailbox.organization_id)
  const indexed: string[] = []
  // One message at a time: a raw copy can be 40 MB.
  for (const row of rows) {
    if (!row.rawKey || row.draft) continue
    const res = await getObject(env, bucket, row.rawKey)
    if (!res) continue
    const raw = new Uint8Array(await res.arrayBuffer())
    const parsed = await parseRaw(raw)
    result.messages++
    const filed = await fileAttachments(env, mailbox, bucket, row, raw, parsed, fresh.direction)
    result.filed += filed.filed
    result.blocked += filed.blocked
    indexed.push(row.id)
    // Agents see received mail that is in the Inbox, as with Stalwart mail.
    if (fresh.direction === 'in' && fresh.offer !== false && row.folder === 'inbox') {
      const offered = await offerStoredEmail(
        env,
        mailbox,
        triggerEmailOf({ ...row, to: parsed.to, cc: parsed.cc, text: parsed.text, headers: parsed.headers }),
      )
      result.fired += offered.fired
      result.skipped += offered.skipped
    }
  }
  await enqueueEmails(env, mailbox.id, indexed)
  return result
}

/**
 * Files a message's attachments in `files` and copies each to its own object, as mail sync does for Stalwart mail:
 * the row is claimed first (its part id is the part's position in the raw copy), so a retry leaves it alone; the
 * file-type rules decide, and a blocked file is recorded, never copied. Each filed one is queued for search.
 */
async function fileAttachments(
  env: Env,
  mailbox: MailboxRow,
  bucket: string,
  row: StoreEventRow,
  raw: Uint8Array,
  parsed: ParsedMessage,
  direction: 'in' | 'out',
): Promise<{ filed: number; blocked: number }> {
  const out = { filed: 0, blocked: 0 }
  for (const part of fileParts(parsed.parts)) {
    const bytes = decodePart(raw.subarray(part.start, part.start + part.length), part.encoding)
    if ((part.disposition === 'inline' || part.contentId) && bytes.length < SMALL_INLINE_BYTES) continue
    const partId = `store:${part.start}`
    const existing = await filesDb.findPart(env.DB, mailbox.id, row.id, partId)
    if (existing?.status === 'ready' || existing?.status === 'deleted') continue

    const name = cleanFileName(partName(part) ?? 'attachment')
    const contentType = part.type || 'application/octet-stream'
    const id = existing?.id ?? crypto.randomUUID()
    const key = existing?.r2_key ?? fileKey(mailbox.id, id, name, new Date(row.receivedAt))
    if (!existing) {
      const { meta } = await filesDb
        .insert(env.DB, {
          id,
          organization_id: mailbox.organization_id,
          mailbox_id: mailbox.id,
          r2_key: key,
          name,
          content_type: contentType,
          size_bytes: bytes.length,
          source: direction === 'out' ? 'sent' : 'received',
          status: 'pending',
          email_id: row.id,
          thread_id: row.threadId,
          part_id: partId,
          stalwart_blob_id: null,
          disposition: part.disposition === 'inline' ? 'inline' : 'attachment',
          content_id: part.contentId,
          created_by: null,
          created_at: new Date().toISOString(),
        })
        .run()
      if (!meta.changes) continue
    }
    try {
      const { safety, body } = await inspectStream(new Response(bytes).body!, name)
      await body.cancel().catch(() => null)
      if (safety.level === 'blocked') {
        await filesDb.markBlocked(env.DB, id, encodeSafety(safety), new Date().toISOString()).run()
        out.blocked++
        continue
      }
      await putObject(env, bucket, key, bytes, { contentType, metadata: { 'file-id': id } })
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
      await env.DB.batch([filesDb.markReady(env.DB, id, bytes.length, sha256), filesDb.setSafety(env.DB, id, encodeSafety(safety))])
      await enqueueIndex(env, [id])
      out.filed++
    } catch (err) {
      // Leave nothing half-done: the retried event claims and files it again.
      await deleteObject(env, bucket, key).catch(() => null)
      await filesDb.remove(env.DB, id).run()
      throw err
    }
  }
  return out
}

/**
 * Hourly: a store-held mailbox's messages from before events existed are queued once, so they are filed, indexed
 * and offered to agents too. Each mailbox's store remembers it was done.
 */
export async function catchUpHeld(env: Env): Promise<{ mailboxes: number; queued: number }> {
  const result = { mailboxes: 0, queued: 0 }
  for (const { id } of await mailboxesDb.heldByStore(env.DB)) {
    const stub = await store(env, id)
    if (await stub.caughtUp()) continue
    const ids = await stub.allIds()
    const rows = await stub.rows(ids)
    // Old mail: filed and indexed, but not offered to agents, which would answer weeks-old messages.
    const sent = rows.filter((r) => r.folder === 'sent').map((r) => r.id)
    const received = rows.filter((r) => r.folder !== 'sent').map((r) => r.id)
    await queueMailEvent(env, { kind: 'new', mailboxId: id, ids: sent, direction: 'out' })
    await queueMailEvent(env, { kind: 'new', mailboxId: id, ids: received, direction: 'in', offer: false })
    await stub.caughtUp(true)
    result.mailboxes++
    result.queued += ids.length
  }
  return result
}
