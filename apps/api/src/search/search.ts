// storage_search: the passages that best answer a question, among the files the actor may open. Runs as the
// token's user: Vectorize filters (searchScopes) only narrow the candidates, and every hit is then checked in D1
// with the same roleOn rule that opening the file uses. Passages are the files' own text, so to an agent they are
// data, not instructions.

import * as filesDb from '../db/files'
import type { FileRow } from '../db/files'
import * as membersDb from '../db/members'
import * as searchDb from '../db/search'
import { fileDoc } from '../db/search'
import type { DocRow } from '../db/search'
import * as storageDb from '../db/storage'
import type { ItemView } from '../db/storage'
import { ApiError } from '../errors'
import type { Actor, EmailEnv } from '../mailserver/types'
import { isAdmin, readableMailboxes } from '../mailserver/access'
import { stripFooter } from '../mailserver/footer'
import * as jmap from '../mailserver/stalwart/mail'
import { store } from '../mailbox/stub'
import { answeredByStore } from '../mailbox/read'
import type { MailboxRow } from '../db/mailboxes'
import { atLeast, hiddenAbove, inTrash, mailScopes, roleOn, searchScopes, type Reader, type SearchFilter } from '../storage/roles'
import { hasMailFilter, matchesMail, type MailFilter } from './mail-filter'
import { embed, query, TOP_K, type Hit, type VectorEnv } from './vectors'

export type SearchEnv = EmailEnv & VectorEnv & Pick<Env, 'SEARCH_RATE'>

/** fileId asks one document only (a Storage file's current version or a mail attachment), any number of passages. */
export type SearchInput = {
  organizationId: string
  q: string
  folderId?: string
  fileId?: string
  limit: number
  /** Mail only (bodies and attachments), for email_search; Storage files are left out. */
  mailOnly?: boolean
  /** One mailbox's mail only. */
  mailboxId?: string
  /** Sender and date filters, checked on mail results (Storage files never pass them). */
  mail?: MailFilter
}

export type SearchResult = {
  /** A Storage file ("storage"), a mail attachment ("mail") or a message's body ("email"). */
  where: 'storage' | 'mail' | 'email'
  /** The file; for an email, the message id (read the whole conversation with email_get_thread). */
  fileId?: string
  emailId?: string | null
  /** The file's name, or the email's subject. */
  name: string
  /** The passage's vector id, unique per result. */
  id: string
  /** The passage's score, 0–1, higher is closer. */
  score: number
  /** The passage itself, and its position in the file (0 first). */
  passage: string
  pos: number
  /** Storage files: the item to read, its current version and the folders above it the reader can see. */
  itemId?: string
  version?: number
  path?: { id: string; name: string }[]
  /** Mail attachments and emails: the mailbox, and the message (an attachment's is the one it came with). */
  mailbox?: { id: string; address: string }
  threadId?: string | null
  /**
   * Emails: who sent it, when it arrived, and the folder it is in (inbox, sent, drafts, archive, junk or trash).
   * Attachments found by email_search: the sender and arrival time of the message they came with.
   */
  from?: string
  receivedAt?: string
  folder?: string | null
}

/** Passages from the same file kept in one answer, so one long file can't fill the list. */
const PER_DOC = 3
/** Queries in flight at once. */
const PARALLEL = 5
/** How many failed documents one retry can exclude while the filter stays under 2 KB. */
const NIN_MAX = 40

export async function search(env: SearchEnv, actor: Actor, input: SearchInput): Promise<{ results: SearchResult[] }> {
  const member = await membersDb.find(env.DB, input.organizationId, actor.userId)
  if (!member) throw new ApiError('organization_not_found', 'Organization not found', 404)
  const { success } = await env.SEARCH_RATE.limit({ key: actor.userId })
  if (!success) throw new ApiError('rate_limited', 'Search is limited to 60 calls a minute; try again shortly', 429)

  const reader: Reader = { memberId: member.id, admin: isAdmin(member) }
  const [mailboxes, folder] = await Promise.all([
    readableMailboxes(env, actor, input.organizationId),
    input.folderId ? folderScope(env, actor, input.folderId, input.organizationId) : null,
  ])
  const inScope = input.mailboxId ? mailboxes.filter((m) => m.id === input.mailboxId) : mailboxes
  if (input.mailboxId && !inScope.length) throw new ApiError('mailbox_not_found', 'Mailbox not found', 404)
  const mailboxById = new Map(inScope.map((m) => [m.id, m]))
  if (input.mailOnly && !mailboxById.size) return { results: [] }

  // Inside one folder, its top-level ancestor is the only scope; the path check below keeps hits to the folder.
  const filters: SearchFilter[] = folder
    ? [{ top: { $in: [folder.top] } }]
    : input.mailOnly
      ? mailScopes([...mailboxById.keys()])
      : searchScopes(reader, await storageDb.accessTops(env.DB, input.organizationId, member.id), [...mailboxById.keys()])
  const options = { folderId: folder?.id, mail: hasMailFilter(input.mail) ? input.mail : undefined, mailOnly: !!input.mailOnly }

  const [vector] = await embed(env, [input.q])
  if (!vector) throw new Error('search: no embedding')

  // One document: filter on it alone (doc is a metadata index); the checker still decides whether the actor may
  // open it, so this can't reach a file the scopes above would have left out.
  if (input.fileId) {
    const doc = fileDoc(input.fileId)
    const check = new Checker(env, actor, reader, mailboxById, { ...options, folderId: undefined })
    const hits = await query(env, input.organizationId, vector, { doc } as unknown as SearchFilter)
    const results = await check.keep(merge(hits, input.limit))
    // Same answer for a file that doesn't exist and one the actor can't open.
    if (!results.length && check.failed.has(doc)) throw new ApiError('file_not_found', 'File not found', 404)
    return { results: results.slice(0, input.limit) }
  }

  const run = (filter: SearchFilter) => query(env, input.organizationId, vector, filter)
  const first = await inBatches(filters, run)
  const check = new Checker(env, actor, reader, mailboxById, options)
  const results = await check.keep(merge(first.flat()))

  // Vectorize has no paging: when hits were dropped and a query was full, ask again without those documents. With
  // sender or date filters most of the nearest documents can fail them, so it asks up to three times.
  const rounds = options.mail ? 3 : 1
  const seen = new Set(results.map((r) => r.id))
  let full = filters.filter((_, i) => first[i]!.length === TOP_K)
  for (let round = 0; round < rounds && results.length < input.limit && check.failed.size && full.length; round++) {
    const nin = [...check.failed].slice(0, NIN_MAX)
    const again = await inBatches(full, (f) => run({ ...f, doc: { $nin: nin } } as SearchFilter))
    const more = await check.keep(merge(again.flat()).filter((h) => !seen.has(h.id)))
    for (const r of more) seen.add(r.id)
    results.push(...more)
    full = full.filter((_, i) => again[i]!.length === TOP_K)
  }
  results.sort((a, b) => b.score - a.score)
  return { results: perDocument(results).slice(0, input.limit) }
}

/** At most PER_DOC passages per document, across every round of asking. */
function perDocument(results: SearchResult[]): SearchResult[] {
  const count = new Map<string, number>()
  return results.filter((r) => {
    const doc = r.id.slice(0, r.id.lastIndexOf(':'))
    const n = (count.get(doc) ?? 0) + 1
    count.set(doc, n)
    return n <= PER_DOC
  })
}

/** A folder the actor may view, and its top-level ancestor. */
async function folderScope(env: SearchEnv, actor: Actor, folderId: string, organizationId: string) {
  const chain = await storageDb.chain(env.DB, folderId, actor.userId)
  const folder = chain[0]
  const member = folder && (await membersDb.find(env.DB, folder.organization_id, actor.userId))
  if (!folder || !member || folder.organization_id !== organizationId || folder.kind !== 'folder') {
    throw new ApiError('folder_not_found', 'Folder not found', 404)
  }
  const role = roleOn(chain, { memberId: member.id, admin: isAdmin(member) })
  if (!role || inTrash(chain)) throw new ApiError('folder_not_found', 'Folder not found', 404)
  return { id: folder.id, top: chain.at(-1)!.id }
}

async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += PARALLEL) out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))))
  return out
}

/** Hits by score, each vector once, at most perDoc per document. */
function merge(hits: Hit[], perDocMax = PER_DOC): Hit[] {
  const byId = new Map<string, Hit>()
  for (const h of hits) if ((byId.get(h.id)?.score ?? -1) < h.score) byId.set(h.id, h)
  const perDoc = new Map<string, number>()
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .filter((h) => {
      const n = (perDoc.get(h.metadata.doc) ?? 0) + 1
      perDoc.set(h.metadata.doc, n)
      return n <= perDocMax
    })
}

/** The permission check on hits, in two batched D1 queries per round. Remembers the documents that failed. */
class Checker {
  readonly failed = new Set<string>()

  constructor(
    private env: SearchEnv,
    private actor: Actor,
    private reader: Reader,
    private mailboxes: Map<string, Pick<MailboxRow, 'id' | 'address' | 'stalwart_id' | 'store_mode' | 'backend'>>,
    private options: { folderId: string | undefined; mail: MailFilter | undefined; mailOnly: boolean },
  ) {}

  async keep(hits: Hit[]): Promise<SearchResult[]> {
    const docs = hits.map((h) => ({ hit: h, doc: searchDb.parseDoc(h.metadata.doc) }))
    const fileIds = [...new Set(docs.flatMap((d) => (d.doc?.kind === 'file' ? [d.doc.fileId] : [])))]
    const emailDocs = [...new Set(docs.flatMap((d) => (d.doc?.kind === 'email' ? [d.hit.metadata.doc] : [])))]
    const [files, emails] = await Promise.all([filesDb.findMany(this.env.DB, fileIds), searchDb.findMany(this.env.DB, emailDocs)])
    const itemIds = [...files.values()].filter((f) => f.item_id).map((f) => f.item_id!)
    const chains = await storageDb.chains(this.env.DB, itemIds, this.actor.userId)

    const kept: { doc: string; result: SearchResult }[] = []
    for (const { hit, doc } of docs) {
      let result: SearchResult | null = null
      if (doc?.kind === 'file') {
        const file = files.get(doc.fileId)
        result = file ? this.fileResult(hit, file, file.item_id ? chains.get(file.item_id) : undefined) : null
      } else if (doc?.kind === 'email') {
        result = this.emailResult(hit, doc, emails.get(hit.metadata.doc))
      }
      if (result && this.options.mailOnly && result.where === 'storage') result = null
      if (result) kept.push({ doc: hit.metadata.doc, result })
      else this.failed.add(hit.metadata.doc)
    }
    if (this.options.mailOnly || this.options.mail) await this.addSenders(kept.map((k) => k.result))
    const filter = this.options.mail
    if (!filter) return kept.map((k) => k.result)
    return kept.flatMap(({ doc, result }) => {
      if (result.where !== 'storage' && matchesMail(filter, result.from, result.receivedAt)) return [result]
      this.failed.add(doc)
      return []
    })
  }

  /** Who sent the message an attachment came with, and when it arrived: one Email/get per mailbox. */
  private async addSenders(results: SearchResult[]): Promise<void> {
    const attachments = results.filter((r) => r.where === 'mail' && r.mailbox && r.emailId)
    if (!attachments.length) return
    const byMailbox = new Map<string, Set<string>>()
    for (const r of attachments) {
      const ids = byMailbox.get(r.mailbox!.id) ?? new Set()
      ids.add(r.emailId!)
      byMailbox.set(r.mailbox!.id, ids)
    }
    // Mailboxes read from their own store answer from it; the rest ask Stalwart.
    const fromStore = [...byMailbox].filter(([mailboxId]) => { const m = this.mailboxes.get(mailboxId); return !!m && answeredByStore(m) })
    const accounts = [...byMailbox].flatMap(([mailboxId, ids]) => {
      const mailbox = this.mailboxes.get(mailboxId)
      return mailbox && !answeredByStore(mailbox) ? [{ mailboxId, accountId: mailbox.stalwart_id, ids: [...ids] }] : []
    })
    const [heads, storeHeads] = await Promise.all([
      jmap.getEmailHeads(this.env, accounts),
      Promise.all(fromStore.map(async ([mailboxId, ids]) => ({ mailboxId, heads: await (await store(this.env, mailboxId)).heads([...ids]) }))),
    ])
    const byEmail = new Map<string, { from: { email: string }[] | null; receivedAt: string }>([
      ...accounts.flatMap(({ mailboxId, accountId }) => (heads.get(accountId) ?? []).map((h) => [`${mailboxId}:${h.id}`, h] as const)),
      ...storeHeads.flatMap(({ mailboxId, heads }) => heads.map((h) => [`${mailboxId}:${h.id}`, h] as const)),
    ])
    for (const r of attachments) {
      const head = byEmail.get(`${r.mailbox!.id}:${r.emailId}`)
      if (!head) continue
      r.from = head.from?.[0]?.email
      r.receivedAt = head.receivedAt
    }
  }

  private base(hit: Hit) {
    return { id: hit.id, score: hit.score, passage: hit.metadata.text, pos: Number(hit.metadata.pos) || 0 }
  }

  /** A message: its mailbox must be readable, and its row still there (mail sync removes it when the message goes). */
  private emailResult(hit: Hit, doc: { mailboxId: string; emailId: string }, row: DocRow | undefined): SearchResult | null {
    const mailbox = this.mailboxes.get(doc.mailboxId)
    if (!mailbox || row?.status !== 'indexed') return null
    return {
      where: 'email',
      ...this.base(hit),
      passage: stripFooter(hit.metadata.text),
      emailId: doc.emailId,
      name: hit.metadata.title ?? '',
      threadId: hit.metadata.thread ?? null,
      from: hit.metadata.from,
      receivedAt: hit.metadata.at,
      folder: row.folder,
      mailbox: { id: mailbox.id, address: mailbox.address },
    }
  }

  private fileResult(hit: Hit, file: FileRow, chain: (ItemView & { depth: number })[] | undefined): SearchResult | null {
    if (file.status !== 'ready' || file.search_excluded) return null
    const base = { ...this.base(hit), fileId: file.id, name: file.name }
    if (file.item_id) {
      const item = chain?.[0]
      if (!item || item.file_id !== file.id || inTrash(chain!)) return null
      if (!atLeast(roleOn(chain!, this.reader), 'viewer')) return null
      if (this.options.folderId && !chain!.some((n) => n.id === this.options.folderId && n.depth > 0)) return null
      const visible = chain!.slice(1, chain!.length - hiddenAbove(chain!, this.reader)).reverse()
      return {
        where: 'storage',
        ...base,
        name: item.name,
        itemId: item.id,
        version: item.version,
        path: visible.map((n) => ({ id: n.id, name: n.name })),
      }
    }
    const mailbox = file.mailbox_id ? this.mailboxes.get(file.mailbox_id) : undefined
    if (!mailbox || (file.source !== 'received' && file.source !== 'sent')) return null
    return {
      where: 'mail',
      ...base,
      mailbox: { id: mailbox.id, address: mailbox.address },
      emailId: file.email_id,
      threadId: file.thread_id,
    }
  }
}
