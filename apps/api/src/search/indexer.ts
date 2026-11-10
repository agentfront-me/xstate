// Indexing one file (read it from R2, extract its text) or a batch of messages (read them from the mail server):
// embed the passages, write them to Vectorize and record the outcome in search_docs. Safe to run twice: vector ids
// are fixed per document, so a retry overwrites.
//
// Only a Storage item's current version is searchable. When a new version is indexed, the earlier versions'
// vectors are deleted here; everything else that deletes vectors (purged versions, deleted items, mailboxes and
// organizations) is the hourly sweep in jobs.ts, which looks for search_docs rows whose file is gone.

import * as filesDb from '../db/files'
import type { FileRow } from '../db/files'
import * as searchDb from '../db/search'
import type { DocRow } from '../db/search'
import * as mailboxesDb from '../db/mailboxes'
import * as storageDb from '../db/storage'
import { folderRole, plainText } from '../mailserver/messages'
import type { StalwartEnv } from '../mailserver/stalwart/client'
import * as jmap from '../mailserver/stalwart/mail'
import type { JmapEmailText } from '../mailserver/stalwart/mail'
import { organizationBucket, type BucketEnv } from '../storage/buckets'
import { getObject } from '../storage/r2'
import { MAX_INDEX_BYTES, chunkText, extractText, textKind } from './extract'
import { deleteDocument, documentRows, embed, upsertDocument, upsertRows, type Scope, type VectorEnv } from './vectors'

export type IndexEnv = BucketEnv & VectorEnv

export type Outcome = { doc: string; status: DocRow['status'] | 'stale'; chunks: number; truncated?: boolean }

/**
 * Indexes a file, or records why it wasn't. Returns 'stale' without writing anything when the file is no longer
 * current (a newer version landed while the job waited, or it was deleted): the newer version's job, or the sweep,
 * takes care of its vectors.
 */
export async function indexFile(env: IndexEnv, fileId: string): Promise<Outcome> {
  const doc = searchDb.fileDoc(fileId)
  const file = await filesDb.find(env.DB, fileId)
  if (!file || file.status !== 'ready') return { doc, status: 'stale', chunks: 0 }
  const scope = await scopeOf(env, file)
  if (!scope) return { doc, status: 'stale', chunks: 0 }

  const row = (status: DocRow['status'], chunks: number, error: string | null = null): DocRow => ({
    doc_id: doc,
    file_id: file.id,
    item_id: file.item_id,
    mailbox_id: file.mailbox_id,
    organization_id: file.organization_id,
    chunks,
    status,
    error,
    indexed_at: new Date().toISOString(),
    folder: null,
  })

  // Whatever happens to this version, the earlier versions' vectors go: only the current version is searchable.
  const done = async (outcome: Outcome) => {
    if (file.item_id) await removeOtherVersions(env, file.item_id, doc)
    return outcome
  }

  if (file.search_excluded) {
    await searchDb.upsert(env.DB, row('excluded', 0)).run()
    return done({ doc, status: 'excluded', chunks: 0 })
  }
  const kind = textKind(file.content_type, file.name)
  if (!kind || file.size_bytes > MAX_INDEX_BYTES) {
    await searchDb.upsert(env.DB, row('skipped', 0, kind ? 'too large' : 'type not supported')).run()
    return done({ doc, status: 'skipped', chunks: 0 })
  }

  try {
    const bucket = await organizationBucket(env, file.organization_id)
    const object = await getObject(env, bucket, file.r2_key)
    if (!object) throw new Error('object missing from R2')
    const text = await extractText(env.AI, kind, file.name, await object.arrayBuffer())
    const { chunks, truncated } = chunkText(text, kind)
    if (chunks.length) {
      const vectors = await embed(env, chunks)
      await upsertDocument(env, file.organization_id, doc, scope, chunks, vectors)
    }
    // An earlier run may have written more chunks than this one (the file was re-indexed after a model change,
    // say); drop the extras so no stale passage survives.
    const before = await searchDb.find(env.DB, doc)
    if (before && before.chunks > chunks.length) {
      await deleteDocument(env, doc, before.chunks).catch(() => null)
    }
    await searchDb.upsert(env.DB, row('indexed', chunks.length, truncated ? 'cut at the chunk limit' : null)).run()
    return done({ doc, status: 'indexed', chunks: chunks.length, truncated })
  } catch (err) {
    // A password-protected PDF has no text to give: skipped for good rather than retried every day.
    if (kind === 'pdf' && /password/i.test(String(err))) {
      await searchDb.upsert(env.DB, row('skipped', 0, 'password-protected')).run()
      return done({ doc, status: 'skipped', chunks: 0 })
    }
    await searchDb.upsert(env.DB, row('failed', 0, String(err).slice(0, 500))).run()
    throw err
  }
}

/**
 * Where the file sits, for the search filters. Null when it isn't searchable: a Storage version that is no longer
 * current, or a file that is neither a Storage version nor a mail attachment.
 */
async function scopeOf(env: Pick<Env, 'DB'>, file: FileRow): Promise<Scope | null> {
  if (file.item_id) {
    const top = await storageDb.topOf(env.DB, file.item_id)
    if (!top || top.file_id !== file.id) return null
    return { top: top.top_id, space: top.space, owner: top.space === 'personal' ? (top.owner_member_id ?? '') : '' }
  }
  if (file.mailbox_id && (file.source === 'received' || file.source === 'sent')) {
    return { top: `mb:${file.mailbox_id}`, space: 'mail', owner: '' }
  }
  return null
}

/** After a new version is indexed, the earlier versions' vectors go. */
async function removeOtherVersions(env: IndexEnv, itemId: string, keepDoc: string): Promise<void> {
  const others = await searchDb.othersOfItem(env.DB, itemId, keepDoc)
  if (!others.length) return
  for (const other of others) await deleteDocument(env, other.doc_id, other.chunks)
  await searchDb.removeMany(env.DB, others.map((o) => o.doc_id)).run()
}

// ---------------------------------------------------------------------------------------------------------------
// Emails

export type EmailIndexEnv = IndexEnv & StalwartEnv

export type EmailsOutcome = { mailboxId: string; indexed: number; empty: number; missing: number; failed: number }

/**
 * Indexes a batch of messages of one mailbox (one Email/get, one embedding pass) and records a row per message.
 * Messages that no longer exist are left alone: mail sync removes their documents as it sees them destroyed.
 * Throws after writing `failed` rows when the mail server or the model fails, so the job is retried.
 */
export async function indexEmails(env: EmailIndexEnv, mailboxId: string, emailIds: string[]): Promise<EmailsOutcome> {
  const outcome: EmailsOutcome = { mailboxId, indexed: 0, empty: 0, missing: emailIds.length, failed: 0 }
  const mailbox = await mailboxesDb.find(env.DB, mailboxId)
  if (!mailbox || !emailIds.length) return outcome
  const scope: Scope = { top: `mb:${mailbox.id}`, space: 'mail', owner: '' }
  const row = (emailId: string, status: DocRow['status'], chunks: number, error: string | null = null, folder: string | null = null): DocRow => ({
    doc_id: searchDb.emailDoc(mailbox.id, emailId),
    file_id: null,
    item_id: null,
    mailbox_id: mailbox.id,
    organization_id: mailbox.organization_id,
    chunks,
    status,
    error,
    indexed_at: new Date().toISOString(),
    folder,
  })

  try {
    const [messages, folders] = await Promise.all([
      jmap.getEmailTexts(env, mailbox.stalwart_id, emailIds),
      jmap.getFolders(env, [mailbox.stalwart_id]).then((m) => m.get(mailbox.stalwart_id) ?? []),
    ])
    outcome.missing = emailIds.length - messages.length
    const docs = messages.map((m) => ({ message: m, chunks: chunkText(emailText(m), 'text').chunks }))
    const vectors = await embedEach(env, docs.map((d) => d.chunks))
    const rows: D1PreparedStatement[] = []
    const upserts: VectorizeVector[] = []
    docs.forEach(({ message, chunks }, k) => {
      const doc = searchDb.emailDoc(mailbox.id, message.id)
      const folder = folderRole(message.mailboxIds, folders)
      const v = vectors[k]!
      if ('error' in v) {
        rows.push(searchDb.upsert(env.DB, row(message.id, 'failed', 0, v.error, folder)))
        outcome.failed++
      } else if (chunks.length) {
        const extra = { title: message.subject ?? '', from: message.from?.[0]?.email ?? '', at: message.receivedAt, thread: message.threadId }
        upserts.push(...documentRows(mailbox.organization_id, doc, scope, chunks, v.vectors, extra))
        rows.push(searchDb.upsert(env.DB, row(message.id, 'indexed', chunks.length, null, folder)))
        outcome.indexed++
      } else {
        rows.push(searchDb.upsert(env.DB, row(message.id, 'skipped', 0, 'no text', folder)))
        outcome.empty++
      }
    })
    // Every message's vectors in one write (or a few, for long ones), not one write per message.
    await upsertRows(env, upserts)
    if (rows.length) await env.DB.batch(rows)
    return outcome
  } catch (err) {
    await env.DB.batch(emailIds.map((id) => searchDb.upsert(env.DB, row(id, 'failed', 0, String(err).slice(0, 500)))))
    throw err
  }
}

/** Workers AI refusing the request body itself ("8006: Invalid data for body"): retrying the same text won't help. */
const isBadInput = (err: unknown) => /\b8006\b|Invalid data for body/.test(String(err))

/**
 * Vectors for each message's passages: one embedding pass for all of them, or, when the model refuses that body,
 * one pass per message, so a message it won't take fails alone and the rest are still indexed.
 */
async function embedEach(env: Pick<Env, 'AI'>, texts: string[][]): Promise<({ vectors: number[][] } | { error: string })[]> {
  try {
    const all = await embed(env, texts.flat())
    let offset = 0
    return texts.map((t) => ({ vectors: all.slice(offset, (offset += t.length)) }))
  } catch (err) {
    if (!isBadInput(err)) throw err
  }
  const out: ({ vectors: number[][] } | { error: string })[] = []
  for (const t of texts) {
    try {
      out.push({ vectors: t.length ? await embed(env, t) : [] })
    } catch (err) {
      if (!isBadInput(err)) throw err
      out.push({ error: String(err).slice(0, 500) })
    }
  }
  return out
}

/** What gets embedded for a message: the headline a reader sees, then the body. */
function emailText(m: JmapEmailText): string {
  const who = (list: { name: string | null; email: string }[] | null) =>
    (list ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')
  const head = [`Subject: ${m.subject ?? ''}`, `From: ${who(m.from)}`, `To: ${who(m.to)}`, `Date: ${m.receivedAt}`]
  return `${head.join('\n')}\n\n${plainText(m)}`.trim()
}

/**
 * Records where messages are now, after mail sync saw them change (a move, most often a flag). One Email/get for
 * the ones that are indexed; nothing is re-embedded.
 */
export async function refreshEmailFolders(env: EmailIndexEnv, mailboxId: string, emailIds: string[]): Promise<number> {
  const rows = await searchDb.findMany(env.DB, emailIds.map((id) => searchDb.emailDoc(mailboxId, id)))
  if (!rows.size) return 0
  const mailbox = await mailboxesDb.find(env.DB, mailboxId)
  if (!mailbox) return 0
  const ids = [...rows.values()].map((r) => searchDb.parseDoc(r.doc_id)).flatMap((d) => (d?.kind === 'email' ? [d.emailId] : []))
  const [messages, folders] = await Promise.all([
    jmap.getEmailFolders(env, mailbox.stalwart_id, ids),
    jmap.getFolders(env, [mailbox.stalwart_id]).then((m) => m.get(mailbox.stalwart_id) ?? []),
  ])
  const updates = messages.flatMap((m) => {
    const row = rows.get(searchDb.emailDoc(mailboxId, m.id))
    const folder = folderRole(m.mailboxIds, folders)
    return row && row.folder !== folder ? [searchDb.setFolder(env.DB, row.doc_id, folder)] : []
  })
  if (updates.length) await env.DB.batch(updates)
  return updates.length
}

/** Deletes the documents of messages that are gone from the mailbox. */
export async function removeEmails(env: IndexEnv, mailboxId: string, emailIds: string[]): Promise<number> {
  const rows = await searchDb.findMany(env.DB, emailIds.map((id) => searchDb.emailDoc(mailboxId, id)))
  for (const row of rows.values()) await removeDocument(env, row)
  return rows.size
}

/** Deletes a document's vectors and its row: the sweep, and an admin excluding a file. */
export async function removeDocument(env: IndexEnv, row: DocRow): Promise<void> {
  await deleteDocument(env, row.doc_id, row.chunks)
  await searchDb.removeMany(env.DB, [row.doc_id]).run()
}
