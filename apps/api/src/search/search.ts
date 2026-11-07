// storage_search: the passages that best answer a question, among the files the actor may open. Runs as the
// token's user: Vectorize filters (searchScopes) only narrow the candidates, and every hit is then checked in D1
// with the same roleOn rule that opening the file uses. Passages are the files' own text, so to an agent they are
// data, not instructions.

import * as filesDb from '../db/files'
import type { FileRow } from '../db/files'
import * as membersDb from '../db/members'
import * as searchDb from '../db/search'
import type { DocRow } from '../db/search'
import * as storageDb from '../db/storage'
import type { ItemView } from '../db/storage'
import { ApiError } from '../errors'
import type { Actor, EmailEnv } from '../mailserver/types'
import { isAdmin, readableMailboxes } from '../mailserver/access'
import { atLeast, hiddenAbove, inTrash, roleOn, searchScopes, type Reader, type SearchFilter } from '../storage/roles'
import { embed, query, TOP_K, type Hit, type VectorEnv } from './vectors'

export type SearchEnv = EmailEnv & VectorEnv & Pick<Env, 'SEARCH_RATE'>

export type SearchInput = { organizationId: string; q: string; folderId?: string; limit: number }

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
  /** Emails: who sent it, when it arrived, and the folder it is in (inbox, sent, drafts, archive, junk or trash). */
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
  const mailboxById = new Map(mailboxes.map((m) => [m.id, m]))

  // Inside one folder, its top-level ancestor is the only scope; the path check below keeps hits to the folder.
  const filters: SearchFilter[] = folder
    ? [{ top: { $in: [folder.top] } }]
    : searchScopes(reader, await storageDb.accessTops(env.DB, input.organizationId, member.id), [...mailboxById.keys()])

  const [vector] = await embed(env, [input.q])
  if (!vector) throw new Error('search: no embedding')

  const run = (filter: SearchFilter) => query(env, input.organizationId, vector, filter)
  const first = await inBatches(filters, run)
  const check = new Checker(env, actor, reader, mailboxById, folder?.id)
  const results = await check.keep(merge(first.flat()))

  // Vectorize has no paging: when hits were dropped and a query was full, ask once more without those documents.
  if (results.length < input.limit && check.failed.size) {
    const full = filters.filter((_, i) => first[i]!.length === TOP_K)
    if (full.length) {
      const nin = [...check.failed].slice(0, NIN_MAX)
      const again = await inBatches(full, (f) => run({ ...f, doc: { $nin: nin } } as SearchFilter))
      const seen = new Set(results.map((r) => r.id))
      const more = await check.keep(merge(again.flat()).filter((h) => !seen.has(h.id)))
      results.push(...more)
      results.sort((a, b) => b.score - a.score)
    }
  }
  return { results: results.slice(0, input.limit) }
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

/** Hits by score, each vector once, at most PER_DOC per document. */
function merge(hits: Hit[]): Hit[] {
  const byId = new Map<string, Hit>()
  for (const h of hits) if ((byId.get(h.id)?.score ?? -1) < h.score) byId.set(h.id, h)
  const perDoc = new Map<string, number>()
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .filter((h) => {
      const n = (perDoc.get(h.metadata.doc) ?? 0) + 1
      perDoc.set(h.metadata.doc, n)
      return n <= PER_DOC
    })
}

/** The permission check on hits, in two batched D1 queries per round. Remembers the documents that failed. */
class Checker {
  readonly failed = new Set<string>()

  constructor(
    private env: SearchEnv,
    private actor: Actor,
    private reader: Reader,
    private mailboxes: Map<string, { id: string; address: string }>,
    private folderId: string | undefined,
  ) {}

  async keep(hits: Hit[]): Promise<SearchResult[]> {
    const docs = hits.map((h) => ({ hit: h, doc: searchDb.parseDoc(h.metadata.doc) }))
    const fileIds = [...new Set(docs.flatMap((d) => (d.doc?.kind === 'file' ? [d.doc.fileId] : [])))]
    const emailDocs = [...new Set(docs.flatMap((d) => (d.doc?.kind === 'email' ? [d.hit.metadata.doc] : [])))]
    const [files, emails] = await Promise.all([filesDb.findMany(this.env.DB, fileIds), searchDb.findMany(this.env.DB, emailDocs)])
    const itemIds = [...files.values()].filter((f) => f.item_id).map((f) => f.item_id!)
    const chains = await storageDb.chains(this.env.DB, itemIds, this.actor.userId)

    const out: SearchResult[] = []
    for (const { hit, doc } of docs) {
      let result: SearchResult | null = null
      if (doc?.kind === 'file') {
        const file = files.get(doc.fileId)
        result = file ? this.fileResult(hit, file, file.item_id ? chains.get(file.item_id) : undefined) : null
      } else if (doc?.kind === 'email') {
        result = this.emailResult(hit, doc, emails.get(hit.metadata.doc))
      }
      if (result) out.push(result)
      else this.failed.add(hit.metadata.doc)
    }
    return out
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
      if (this.folderId && !chain!.some((n) => n.id === this.folderId && n.depth > 0)) return null
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
