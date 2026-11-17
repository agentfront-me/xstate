// Mail served from a mailbox's own store instead of Stalwart (docs/mailbox-store-plan.md, phase 1), for mailboxes
// whose store_mode is 'read': whole conversations read from the raw copies in the organization's bucket, and
// attachments read back by their position inside them. Anything the store can't answer yet (a message whose raw
// copy isn't made, or a copy missing from the bucket) returns null, and the caller asks Stalwart as before.

import type { MailboxRow } from '../db/mailboxes'
import { EmailError } from '../mailserver/errors'
import * as jmap from '../mailserver/stalwart/mail'
import type { EmailEnv } from '../mailserver/types'
import { checkName } from '../security/attachments'
import { organizationBucket, storageConfigured } from '../storage/buckets'
import { getObject, getObjectRange } from '../storage/r2'
import { decodePart, isBodyText, locateParts, type MimePart, type PartEncoding } from './mime'
import { fileParts, parseRaw, partName } from './parse'
import type { StoreThreadMessage } from './store'
import { store } from './stub'
import type { Message, MessageSummary } from '../mailserver/messages'

/** Raw copies over this are read one at a time, never alongside others, so a request stays within a Worker's memory. */
const BIG_BYTES = 5 * 1024 * 1024
/** Raw copies read at once for one conversation. */
const PARALLEL = 4

/** Whether a mailbox's mail is read from its store. */
export const readsFromStore = (env: EmailEnv, mailbox: MailboxRow) => mailbox.store_mode === 'read' && storageConfigured(env)

/**
 * An attachment's id when its message is read from the store: the message and where the part starts in its raw
 * copy. Stalwart's blob ids are letters and digits only, so the dots tell the two apart.
 */
export const storeBlobId = (emailId: string, start: number) => `store.${emailId}.${start}`

export function parseStoreBlobId(blobId: string): { emailId: string; start: number } | null {
  const m = /^store\.([A-Za-z0-9_-]{1,64})\.(\d{1,10})$/.exec(blobId)
  return m ? { emailId: m[1]!, start: Number(m[2]) } : null
}

/**
 * Every message in a conversation, oldest first, read from the store and the raw copies. Null when any message
 * can't be read that way yet; `summary` turns a store row into the summary the API returns.
 */
export async function storeThread(
  env: EmailEnv,
  mailbox: MailboxRow,
  threadId: string,
  summary: (row: StoreThreadMessage) => MessageSummary,
): Promise<Message[] | null> {
  const rows = await (await store(env, mailbox.id)).thread(threadId)
  if (!rows.length || rows.some((r) => !r.rawKey)) return null
  const bucket = await organizationBucket(env, mailbox.organization_id)
  const messages: (Message | null)[] = rows.map(() => null)
  const readOne = async (i: number) => {
    const row = rows[i]!
    const res = await getObject(env, bucket, row.rawKey!)
    if (!res) return
    messages[i] = await toMessage(row, new Uint8Array(await res.arrayBuffer()), summary(row))
  }
  const small = rows.flatMap((r, i) => ((r.rawSize ?? 0) <= BIG_BYTES ? [i] : []))
  const big = rows.flatMap((r, i) => ((r.rawSize ?? 0) > BIG_BYTES ? [i] : []))
  for (let k = 0; k < small.length; k += PARALLEL) await Promise.all(small.slice(k, k + PARALLEL).map(readOne))
  for (const i of big) await readOne(i)
  if (messages.some((m) => !m)) {
    console.error(`mailbox-store: raw copy missing in thread ${threadId} of ${mailbox.id}; reading from the mail server`)
    return null
  }
  return messages as Message[]
}

async function toMessage(row: StoreThreadMessage, raw: Uint8Array, summary: MessageSummary): Promise<Message> {
  const parsed = await parseRaw(raw)
  const sizes = new Map(row.attachments.map((a) => [a.start, a.size]))
  return {
    ...summary,
    cc: parsed.cc,
    bcc: parsed.bcc,
    replyTo: parsed.replyTo,
    sentAt: parsed.sentAt,
    messageId: parsed.messageId,
    text: parsed.text,
    html: parsed.html,
    attachments: fileParts(parsed.parts).map((part) => {
      const name = partName(part) ?? 'attachment'
      return {
        blobId: storeBlobId(row.id, part.start),
        name,
        type: part.type,
        size: sizes.get(part.start) ?? encodedSize(part),
        inline: part.disposition === 'inline',
        cid: part.contentId,
        safety: checkName(name),
      }
    }),
  }
}

/** A part's decoded size from its encoded length, for one the store has no record of. */
const encodedSize = (part: MimePart) => (part.encoding === 'base64' ? Math.floor((part.length * 3) / 4 / 1.026) : part.length)

/** An attachment of a message read from the store, decoded. Null when it isn't there. */
export async function storeBlob(env: EmailEnv, mailbox: MailboxRow, blobId: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  const id = parseStoreBlobId(blobId)
  if (!id || !storageConfigured(env)) return null
  const place = await (await store(env, mailbox.id)).attachmentAt(id.emailId, id.start)
  if (!place) return null
  const bucket = await organizationBucket(env, mailbox.organization_id)
  if (place.length >= 0) {
    const range = await getObjectRange(env, bucket, place.rawKey, place.start, place.length)
    return range ? { bytes: decodePart(range, place.encoding as PartEncoding), type: place.type } : null
  }
  // Not recorded by the raw copy: find the part in the message itself.
  const res = await getObject(env, bucket, place.rawKey)
  if (!res) return null
  const raw = new Uint8Array(await res.arrayBuffer())
  const part = locateParts(raw).find((p) => p.start === id.start && !isBodyText(p))
  return part ? { bytes: decodePart(raw.subarray(part.start, part.start + part.length), part.encoding), type: part.type } : null
}

/**
 * A blob id the mail server knows, for sending an attachment or reading an invitation: a store attachment is
 * uploaded to the mailbox's Stalwart account first. Other ids are returned as they are.
 */
export async function serverBlobId(env: EmailEnv, mailbox: MailboxRow, blobId: string, type: string): Promise<string> {
  if (!parseStoreBlobId(blobId)) return blobId
  const blob = await storeBlob(env, mailbox, blobId)
  if (!blob) throw new EmailError('attachment_not_found', 'That attachment no longer exists', 404)
  const uploaded = await jmap.uploadBlob(env, mailbox.stalwart_id, blob.bytes, type || blob.type || 'application/octet-stream', blob.bytes.byteLength)
  return uploaded.blobId
}
