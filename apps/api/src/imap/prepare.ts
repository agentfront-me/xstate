// Getting a mailbox's old mail ready for mail apps (docs/imap-smtp-relay-plan.md, 6.5). IMAP reports each message's
// envelope, structure and headers, which the store keeps per message (`imap_meta`, made by ./message.ts from the raw
// copy). New mail gets it the first time a mail app asks; a mailbox's existing mail is done here in the background,
// in batches on the mail-events queue, so a first sync doesn't wait on one R2 read per message.
//
// Started when someone creates an app password (for every mailbox they can open) and when a mail app opens a folder
// that still has many messages to do. Safe to run twice: a message already done is skipped.

import type { MailboxRow } from '../db/mailboxes'
import { store } from '../mailbox/stub'
import { organizationBucket } from '../storage/buckets'
import { getObject } from '../storage/r2'
import { describe } from './message.ts'

const BATCH = 120
const PARALLEL = 6
/** A raw copy larger than this isn't read into memory; the message is described as empty. */
const MAX_BYTES = 45 * 1024 * 1024

export type ImapPrepareJob = { kind: 'imap-meta'; mailboxId: string }

/** Asks for a mailbox's mail to be made ready. Never fails the caller. */
export async function queueImapPrepare(env: Pick<Env, 'MAIL_EVENTS'>, mailboxId: string): Promise<void> {
  try {
    await env.MAIL_EVENTS.send({ kind: 'imap-meta', mailboxId } satisfies ImapPrepareJob)
  } catch (err) {
    console.error('imap-prepare: queueing failed', mailboxId, err)
  }
}

/** One batch: the newest messages still to do. Queues the next batch while any are left. */
export async function prepareForImap(env: Env, mailbox: MailboxRow) {
  const stub = await store(env, mailbox.id)
  const { left, rows } = await stub.imapMissingMeta(BATCH)
  if (!rows.length) return { kind: 'imap-meta', mailboxId: mailbox.id, done: 0, left: 0 }
  const bucket = await organizationBucket(env, mailbox.organization_id)
  const made: { n: number; meta: string }[] = []
  for (let i = 0; i < rows.length; i += PARALLEL) {
    await Promise.all(
      rows.slice(i, i + PARALLEL).map(async (row) => {
        const res = await getObject(env, bucket, row.rawKey)
        const tooBig = Number(res?.headers.get('content-length') ?? 0) > MAX_BYTES
        if (tooBig) await res!.body?.cancel()
        // A raw copy that is gone or too large is described as empty, so it isn't asked for again and again.
        const raw = res && !tooBig ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array(0)
        made.push({ n: row.n, meta: JSON.stringify(describe(raw)) })
      }),
    )
  }
  await stub.imapSetMeta(made)
  if (left > made.length) await queueImapPrepare(env, mailbox.id)
  return { kind: 'imap-meta', mailboxId: mailbox.id, done: made.length, left: left - made.length }
}
