// Keeps a mailbox's MailboxStore in step with Stalwart while Stalwart is still in charge (the shadow copy of
// docs/mailbox-store-plan.md, phase 1). Runs for mailboxes whose store_mode is not 'off'.
//
// Like the attachment sync (storage/mail-sync) it is driven by Stalwart's change log, with its own saved state
// (kept in the store itself), so neither can hold the other up. The first run queues every message of the mailbox
// for copying; after that each run applies what was created, moved, flagged or destroyed since the last one.
// Every step is safe to repeat: storing a message twice replaces it, and a message that is gone is left out.

import * as filesDb from '../db/files'
import * as mailboxesDb from '../db/mailboxes'
import type { MailboxRow } from '../db/mailboxes'
import { stripFooter } from '../mailserver/footer'
import { folderRole, plainText } from '../mailserver/messages'
import * as jmap from '../mailserver/stalwart/mail'
import type { JmapFolder, JmapStoreEmail } from '../mailserver/stalwart/mail'
import type { SearchJob } from '../search/jobs'
import { organizationBucket, storageConfigured, type BucketEnv } from '../storage/buckets'
import { deleteObject, getObjectRange, putObject } from '../storage/r2'
import { decodePart, isBodyText } from './mime'
import { parseDifferences } from './compare'
import { parseRaw } from './parse'
import type { RawStats, StoreAttachment, StoreRaw } from './store'
import { MAX_INDEXED_CHARS, type StoreMessage, type StorePlacement } from './query'
import { store } from './stub'

export type ShadowEnv = BucketEnv & Pick<Env, 'DB' | 'STALWART_URL' | 'STALWART_API_KEY' | 'MAILBOX_STORE' | 'SEARCH_INDEX'>

/** Messages per Email/get, and per call into the store. */
const BATCH = 25
/** Messages per queued copy job. */
const PER_JOB = 50
/**
 * Raise this to make every store copy its mailbox again from the start: after a change to what the store keeps
 * or how it is filled.
 */
export const COPY_VERSION = 5

/** Raw messages per queued copy job: each is a download and an upload. */
const RAW_PER_JOB = 10
/** Raw copies queued per sync, so a big mailbox's copy spreads over hours and search indexing keeps its turn on the queue. */
const RAW_PER_SYNC = 2000
/** Raw messages over this are not copied (SES accepts 40 MB; anything larger came from an import). */
const MAX_RAW_BYTES = 45 * 1024 * 1024

/** Created messages stored straight away by a sync; a larger burst (an import) goes through the queue. */
const DIRECT_MAX = 50

export type StoreSyncResult = {
  mailboxId: string
  /** The first run for this mailbox: every message was queued for copying. */
  first: boolean
  queued: number
  stored: number
  placed: number
  removed: number
  /** Raw copies queued by this run. */
  rawQueued: number
}

/** Brings one mailbox's store up to date. Null when the mailbox doesn't use the store. */
export async function syncStore(env: ShadowEnv, mailboxId: string): Promise<StoreSyncResult | null> {
  const mailbox = await mailboxesDb.find(env.DB, mailboxId)
  if (!mailbox || mailbox.store_mode === 'off') return null
  const result: StoreSyncResult = { mailboxId, first: false, queued: 0, stored: 0, placed: 0, removed: 0, rawQueued: 0 }
  const accountId = mailbox.stalwart_id
  const stub = await store(env, mailbox.id)
  const folders = (await jmap.getFolders(env, [accountId])).get(accountId) ?? []
  const sync = await stub.getSync()
  if (!sync.state) return firstCopy(env, mailbox, folders, result)
  if (sync.version !== COPY_VERSION) {
    await stub.reset()
    return firstCopy(env, mailbox, folders, result)
  }

  let state = sync.state
  let changed = false
  for (;;) {
    const changes = await jmap.emailChanges(env, accountId, state)
    if (!changes) {
      // The state is too old to diff from: start over with an empty store.
      await stub.reset()
      return firstCopy(env, mailbox, folders, result)
    }
    if (changes.created.length > DIRECT_MAX) {
      await enqueueCopy(env, mailbox.id, changes.created)
      result.queued += changes.created.length
    } else if (changes.created.length) {
      result.stored += await storeEmails(env, mailbox.id, changes.created, { mailbox, folders })
    }
    if (changes.updated.length) result.placed += await refreshPlacements(env, mailbox, folders, changes.updated)
    if (changes.destroyed.length) {
      const gone = await stub.remove(changes.destroyed)
      result.removed += gone.removed
      await deleteRaw(env, mailbox, gone.rawKeys)
    }
    changed ||= !!(changes.created.length || changes.updated.length || changes.destroyed.length)
    state = changes.newState
    await stub.setSync(state, COPY_VERSION)
    if (!changes.hasMoreChanges) break
  }
  // A folder created or renamed shows up as a change to the messages moved into it.
  if (changed) await stub.setFolders(storeFolders(folders))
  result.rawQueued = await queueRaw(env, mailbox)
  return result
}

/** Queues raw copies for messages that don't have one yet, a bounded number per run. */
async function queueRaw(env: ShadowEnv, mailbox: MailboxRow): Promise<number> {
  if (!mailbox.store_raw || !storageConfigured(env)) return 0
  const ids = await (await store(env, mailbox.id)).missingRaw(RAW_PER_SYNC)
  const jobs: SearchJob[] = []
  for (let i = 0; i < ids.length; i += RAW_PER_JOB) jobs.push({ kind: 'store-raw', mailboxId: mailbox.id, emailIds: ids.slice(i, i + RAW_PER_JOB) })
  for (let i = 0; i < jobs.length; i += 100) await env.SEARCH_INDEX.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })))
  return ids.length
}

async function deleteRaw(env: ShadowEnv, mailbox: MailboxRow, keys: string[]): Promise<void> {
  if (!keys.length || !storageConfigured(env)) return
  const bucket = await organizationBucket(env, mailbox.organization_id)
  for (const key of keys) await deleteObject(env, bucket, key).catch((err) => console.error(`mailbox-store: deleting ${key} failed`, err))
}

/** Where a message's raw copy lives in the organization's bucket: inside the mailbox's folder, so it goes with the mailbox. */
export const rawKey = (mailboxId: string, emailId: string) => `${mailboxId}/raw/${emailId}.eml`

const sha256Hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

export type RawCopyResult = { mailboxId: string; stored: number; skipped: number; bytes: number; attachments: number; matched: number; differing: number }

/**
 * Copies raw messages into the organization's bucket and records, in the store, where each attachment sits inside
 * them. Each attachment is matched to its `files` row by content, the first one of each message is read back from
 * the bucket by position to prove the read path, and our own reading of the message is compared with the mail
 * server's. Safe to repeat: the key is fixed per message.
 */
export async function copyRaw(env: ShadowEnv, mailboxId: string, emailIds: string[]): Promise<RawCopyResult> {
  const result: RawCopyResult = { mailboxId, stored: 0, skipped: 0, bytes: 0, attachments: 0, matched: 0, differing: 0 }
  const mailbox = await mailboxesDb.find(env.DB, mailboxId)
  if (!mailbox || mailbox.store_mode === 'off' || !mailbox.store_raw || !storageConfigured(env)) return result
  const accountId = mailbox.stalwart_id
  const bucket = await organizationBucket(env, mailbox.organization_id)
  const emails = await jmap.getStoreEmails(env, accountId, emailIds, MAX_INDEXED_CHARS)
  const records: StoreRaw[] = []
  for (const e of emails) {
    if (e.size > MAX_RAW_BYTES) {
      records.push({ id: e.id, key: '', size: e.size, diff: '', attachments: [] })
      result.skipped++
      continue
    }
    const download = await jmap.downloadBlob(env, accountId, e.blobId, 'message.eml', 'message/rfc822')
    const raw = new Uint8Array(await download.arrayBuffer())
    const key = rawKey(mailbox.id, e.id)
    await putObject(env, bucket, key, raw, { contentType: 'message/rfc822', metadata: { 'email-id': e.id } })

    const parsed = await parseRaw(raw)
    const files = (await filesDb.listForMailbox(env.DB, mailbox.id, { emailId: e.id, limit: 200 })).filter((f) => f.sha256)
    const attachments: StoreAttachment[] = []
    for (const part of parsed.parts) {
      if (isBodyText(part) || !part.length) continue
      const content = decodePart(raw.subarray(part.start, part.start + part.length), part.encoding)
      const hash = await sha256Hex(content)
      let verified: boolean | null = null
      if (!attachments.length) {
        // Prove the read path on one attachment per message: fetch just its range from the bucket and decode it.
        const range = await getObjectRange(env, bucket, key, part.start, part.length)
        verified = !!range && (await sha256Hex(decodePart(range, part.encoding))) === hash
      }
      attachments.push({
        fileId: files.find((f) => f.sha256 === hash)?.id ?? null,
        name: part.name,
        type: part.type,
        size: content.length,
        start: part.start,
        length: part.length,
        encoding: part.encoding,
        verified,
      })
    }
    const theirs = toStoreMessage(e, [])
    const diff = parseDifferences(parsed, { subject: theirs.subject, from: theirs.from, to: theirs.to, text: plainText(e) })
    records.push({ id: e.id, key, size: raw.length, diff: diff.join(','), attachments })
    result.stored++
    result.bytes += raw.length
    result.attachments += attachments.length
    result.matched += attachments.filter((a) => a.fileId).length
    if (diff.length) result.differing++
  }
  if (records.length) {
    const { gone } = await (await store(env, mailbox.id)).setRaw(records)
    // Deleted while it was being copied: take the copy back out.
    await deleteRaw(env, mailbox, gone.map((id) => rawKey(mailbox.id, id)))
  }
  return result
}

/** Notes the current state, then queues every message for copying. Changes after that state come with the next sync. */
async function firstCopy(env: ShadowEnv, mailbox: MailboxRow, folders: JmapFolder[], result: StoreSyncResult): Promise<StoreSyncResult> {
  result.first = true
  const accountId = mailbox.stalwart_id
  const stub = await store(env, mailbox.id)
  const state = (await jmap.getEmailStates(env, [accountId])).get(accountId)!
  await stub.setFolders(storeFolders(folders))
  for (let position = 0; ; position += PER_JOB) {
    const page = await jmap.queryAllEmails(env, accountId, position, PER_JOB)
    await enqueueCopy(env, mailbox.id, page.ids)
    result.queued += page.ids.length
    // A short page is the last one. Not page.total: the first production run got none and stopped after one page.
    if (page.ids.length < PER_JOB) break
  }
  // Saved last: a run that fails part-way queues everything again, which is harmless.
  await stub.setSync(state, COPY_VERSION)
  return result
}

async function enqueueCopy(env: Pick<Env, 'SEARCH_INDEX'>, mailboxId: string, emailIds: string[]): Promise<void> {
  const jobs: SearchJob[] = []
  for (let i = 0; i < emailIds.length; i += PER_JOB) jobs.push({ kind: 'store-emails', mailboxId, emailIds: emailIds.slice(i, i + PER_JOB) })
  // sendBatch takes up to 100 messages.
  for (let i = 0; i < jobs.length; i += 100) await env.SEARCH_INDEX.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })))
}

/**
 * Copies messages into the store as they are on the mail server now. Messages that no longer exist are skipped.
 * Returns how many were stored.
 */
export async function storeEmails(
  env: ShadowEnv,
  mailboxId: string,
  emailIds: string[],
  known?: { mailbox: MailboxRow; folders: JmapFolder[] },
): Promise<number> {
  const mailbox = known?.mailbox ?? (await mailboxesDb.find(env.DB, mailboxId))
  if (!mailbox || mailbox.store_mode === 'off') return 0
  const accountId = mailbox.stalwart_id
  const folders = known?.folders ?? (await jmap.getFolders(env, [accountId])).get(accountId) ?? []
  const stub = await store(env, mailbox.id)
  let stored = 0
  // Oldest first. Ids arrive newest first, in the mail server's own order for messages of the same second; storing
  // them in reverse keeps that order in the store, which lists same-second messages by the order they were stored.
  const oldestFirst = [...emailIds].reverse()
  for (let i = 0; i < oldestFirst.length; i += BATCH) {
    const ids = oldestFirst.slice(i, i + BATCH)
    const position = new Map(ids.map((id, k) => [id, k]))
    // Characters can take several bytes; the store cuts to MAX_INDEXED_CHARS itself.
    const emails = await jmap.getStoreEmails(env, accountId, ids, MAX_INDEXED_CHARS)
    if (!emails.length) continue
    emails.sort((a, b) => position.get(a.id)! - position.get(b.id)!)
    stored += (await stub.upsert(emails.map((e) => toStoreMessage(e, folders)))).stored
  }
  return stored
}

async function refreshPlacements(env: ShadowEnv, mailbox: MailboxRow, folders: JmapFolder[], emailIds: string[]): Promise<number> {
  const stub = await store(env, mailbox.id)
  let changed = 0
  for (let i = 0; i < emailIds.length; i += PER_JOB) {
    const rows = await jmap.getEmailPlacements(env, mailbox.stalwart_id, emailIds.slice(i, i + PER_JOB))
    const placements: StorePlacement[] = rows.map((r) => ({ id: r.id, ...placement(r, folders) }))
    if (placements.length) changed += (await stub.setPlacements(placements)).changed
  }
  return changed
}

const storeFolders = (folders: JmapFolder[]) => folders.map((f) => ({ id: f.id, role: f.role, name: f.name }))

function placement(e: { mailboxIds: Record<string, true>; keywords: Record<string, true> }, folders: JmapFolder[]): Omit<StorePlacement, 'id'> {
  return { folderIds: Object.keys(e.mailboxIds), folder: folderRole(e.mailboxIds, folders), seen: !!e.keywords.$seen, pinned: !!e.keywords.$flagged }
}

function toStoreMessage(e: JmapStoreEmail, folders: JmapFolder[]): StoreMessage {
  const addresses = (list: JmapStoreEmail['from']) => (list ?? []).map((a) => ({ name: a.name || null, email: a.email }))
  return {
    id: e.id,
    threadId: e.threadId,
    ...placement(e, folders),
    from: addresses(e.from),
    to: addresses(e.to),
    subject: e.subject ?? '',
    preview: e.preview ?? '',
    receivedAt: e.receivedAt,
    size: e.size,
    hasAttachment: e.hasAttachment,
    text: stripFooter(plainText(e)),
  }
}

export type StoreCheck = {
  mailboxId: string
  /** Messages on the mail server and in the store, over every folder. */
  server: number
  stored: number
  /** Folders whose counts differ. Empty when the store matches the mail server. */
  differences: { folder: string; server: { total: number; unread: number }; stored: { total: number; unread: number } }[]
  /** The raw copy's progress and what it found, for mailboxes with store_raw on. */
  raw?: RawStats
}

/** Compares the store's per-folder counts with the mail server's. Null when the mailbox doesn't use the store. */
export async function checkStore(env: ShadowEnv, mailboxId: string): Promise<StoreCheck | null> {
  const mailbox = await mailboxesDb.find(env.DB, mailboxId)
  if (!mailbox || mailbox.store_mode === 'off') return null
  const folders = (await jmap.getFolders(env, [mailbox.stalwart_id])).get(mailbox.stalwart_id) ?? []
  const stub = await store(env, mailbox.id)
  const counts = await stub.counts()
  const byFolder = new Map(counts.folders.map((c) => [c.folderId, c]))
  const check: StoreCheck = { mailboxId, server: 0, stored: counts.messages, differences: [] }
  if (mailbox.store_raw) check.raw = await stub.rawStats()
  for (const f of folders) {
    const have = byFolder.get(f.id) ?? { total: 0, unread: 0 }
    check.server += f.totalEmails
    if (have.total !== f.totalEmails || have.unread !== f.unreadEmails) {
      check.differences.push({
        folder: f.role ?? f.name,
        server: { total: f.totalEmails, unread: f.unreadEmails },
        stored: { total: have.total, unread: have.unread },
      })
    }
  }
  return check
}
