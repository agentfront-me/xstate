// JMAP mail (RFC 8621) against any Stalwart account. The admin API key holds the `impersonate` permission, so a
// call reaches another account's mail by setting `accountId` to that account's x:Account id (our stalwart_id).
// See docs/stalwart-api.md §5. Folders are JMAP "Mailbox" objects; we call them folders so they aren't confused
// with xstate mailboxes (which are Stalwart accounts).

import { EmailError } from '../errors'
import { jmap, MAIL_CAPABILITIES, type StalwartEnv } from './client'

type JmapArgs = Record<string, unknown>

export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'junk' | 'trash'
export type JmapFolder = { id: string; name: string; role: string | null; parentId?: string | null; unreadEmails: number; totalEmails: number }
export type JmapAddress = { name: string | null; email: string }
export type JmapEmailSummary = {
  id: string
  threadId: string
  mailboxIds: Record<string, true>
  keywords: Record<string, true>
  from: JmapAddress[] | null
  to: JmapAddress[] | null
  subject: string | null
  preview: string
  receivedAt: string
  hasAttachment: boolean
  size: number
  /** Messages in the conversation; set by queryEmails only. */
  threadSize?: number
}
export type JmapBodyPart = {
  partId: string | null
  blobId: string | null
  name: string | null
  type: string
  size: number
  disposition: string | null
  cid: string | null
}
export type JmapEmail = JmapEmailSummary & {
  cc: JmapAddress[] | null
  replyTo: JmapAddress[] | null
  sentAt: string | null
  messageId: string[] | null
  textBody: JmapBodyPart[]
  htmlBody: JmapBodyPart[]
  attachments: JmapBodyPart[]
  bodyValues: Record<string, { value: string; isTruncated: boolean }>
}

const SUMMARY = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'subject', 'preview', 'receivedAt', 'hasAttachment', 'size']
const FULL = [...SUMMARY, 'cc', 'replyTo', 'sentAt', 'messageId', 'textBody', 'htmlBody', 'attachments', 'bodyValues']
const PART = ['partId', 'blobId', 'name', 'type', 'size', 'disposition', 'cid']
/** Bodies over this size come back truncated; mail that long is rare and still readable as the raw message. */
const MAX_BODY_BYTES = 1_000_000

function mail(env: StalwartEnv, calls: [string, JmapArgs][]) {
  return jmap(env, calls, MAIL_CAPABILITIES)
}

/** Every folder of each account, in one request. */
export async function getFolders(env: StalwartEnv, accountIds: string[]): Promise<Map<string, JmapFolder[]>> {
  if (!accountIds.length) return new Map()
  const results = await mail(
    env,
    accountIds.map((accountId) => [
      'Mailbox/get',
      { accountId, properties: ['name', 'role', 'parentId', 'unreadEmails', 'totalEmails'] },
    ]),
  )
  return new Map(accountIds.map((id, i) => [id, (results[i]!.list as JmapFolder[]) ?? []]))
}

/** Creates a top-level folder with a role (e.g. Archive) and returns its id. */
export async function createFolder(env: StalwartEnv, accountId: string, name: string, role: FolderRole): Promise<string> {
  const [result] = await mail(env, [['Mailbox/set', { accountId, create: { f: { name, role, parentId: null } } }]])
  const id = (result!.created as Record<string, { id: string }> | undefined)?.f?.id
  if (!id) throw new EmailError('mail_server_error', `Couldn't create the ${name} folder`, 502)
  return id
}

/** Creates a plain folder (no role), at the top or inside `parentId`, and returns its id. */
export async function createChildFolder(env: StalwartEnv, accountId: string, name: string, parentId: string | null): Promise<string> {
  const [result] = await mail(env, [['Mailbox/set', { accountId, create: { f: { name, parentId } } }]])
  const id = (result!.created as Record<string, { id: string }> | undefined)?.f?.id
  if (!id) {
    const err = (result!.notCreated as Record<string, { type?: string; description?: string }> | undefined)?.f
    throw new EmailError('mail_server_error', `Couldn't create the folder ${name}: ${err?.description ?? err?.type ?? 'unknown error'}`, 502)
  }
  return id
}

export type EmailQuery = {
  /** Folder ids to look in, or omit for every folder. */
  inFolders?: string[]
  /** Folder ids to leave out. */
  notInFolders?: string[]
  unreadOnly?: boolean
  pinnedOnly?: boolean
  text?: string
  /** Only mail received strictly before this time, for paging. */
  before?: string
  /** Only mail from, to or cc'ing this address. */
  participant?: string
  /** One result per conversation (the default), or every matching message. */
  collapseThreads?: boolean
  limit: number
}

function emailFilter(q: EmailQuery): JmapArgs {
  const conditions: JmapArgs[] = []
  if (q.inFolders?.length === 1) conditions.push({ inMailbox: q.inFolders[0] })
  else if (q.inFolders?.length) conditions.push({ operator: 'OR', conditions: q.inFolders.map((id) => ({ inMailbox: id })) })
  if (q.notInFolders?.length) conditions.push({ inMailboxOtherThan: q.notInFolders })
  if (q.unreadOnly) conditions.push({ notKeyword: '$seen' })
  if (q.pinnedOnly) conditions.push({ hasKeyword: '$flagged' })
  if (q.text) conditions.push({ text: q.text })
  if (q.before) conditions.push({ before: q.before })
  if (q.participant) {
    conditions.push({ operator: 'OR', conditions: [{ from: q.participant }, { to: q.participant }, { cc: q.participant }] })
  }
  return conditions.length === 1 ? conditions[0]! : { operator: 'AND', conditions }
}

/** Runs one query per account in a single request and returns each account's newest matching messages. */
export async function queryEmails(
  env: StalwartEnv,
  queries: { accountId: string; query: EmailQuery }[],
): Promise<Map<string, JmapEmailSummary[]>> {
  if (!queries.length) return new Map()
  const calls: [string, JmapArgs][] = []
  queries.forEach(({ accountId, query }, i) => {
    // collapseThreads (unless turned off): one result per conversation, its newest message that matches the filter.
    calls.push([
      'Email/query',
      {
        accountId,
        filter: emailFilter(query),
        sort: [{ property: 'receivedAt', isAscending: false }],
        collapseThreads: query.collapseThreads ?? true,
        limit: query.limit,
      },
    ])
    calls.push([
      'Email/get',
      { accountId, '#ids': { resultOf: `c${i * 3}`, name: 'Email/query', path: '/ids' }, properties: SUMMARY },
    ])
    calls.push([
      'Thread/get',
      { accountId, '#ids': { resultOf: `c${i * 3 + 1}`, name: 'Email/get', path: '/list/*/threadId' } },
    ])
  })
  const results = await mail(env, calls)
  return new Map(
    queries.map(({ accountId }, i) => {
      const threads = new Map(((results[i * 3 + 2]!.list as JmapThread[]) ?? []).map((t) => [t.id, t.emailIds.length]))
      const emails = ((results[i * 3 + 1]!.list as JmapEmailSummary[]) ?? []).map((e) => ({
        ...e,
        threadSize: threads.get(e.threadId) ?? 1,
      }))
      return [accountId, emails]
    }),
  )
}

type JmapThread = { id: string; emailIds: string[] }

/** Every message in a thread, oldest first, with bodies and attachment parts. */
export async function getThread(env: StalwartEnv, accountId: string, threadId: string): Promise<JmapEmail[]> {
  const [thread, emails] = await mail(env, [
    ['Thread/get', { accountId, ids: [threadId] }],
    [
      'Email/get',
      {
        accountId,
        '#ids': { resultOf: 'c0', name: 'Thread/get', path: '/list/*/emailIds' },
        properties: FULL,
        bodyProperties: PART,
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: MAX_BODY_BYTES,
      },
    ],
  ])
  if (!(thread!.list as unknown[]).length) throw new EmailError('thread_not_found', 'Conversation not found', 404)
  return ((emails!.list as JmapEmail[]) ?? []).sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
}

/** Sets keywords and/or replaces the folders of one message. */
export async function updateEmail(
  env: StalwartEnv,
  accountId: string,
  emailId: string,
  patch: { seen?: boolean; pinned?: boolean; folderId?: string },
): Promise<void> {
  const update: JmapArgs = {}
  if (patch.seen !== undefined) update['keywords/$seen'] = patch.seen || null
  if (patch.pinned !== undefined) update['keywords/$flagged'] = patch.pinned || null
  if (patch.folderId) update.mailboxIds = { [patch.folderId]: true }
  const [result] = await mail(env, [['Email/set', { accountId, update: { [emailId]: update } }]])
  const failed = (result!.notUpdated as Record<string, { type?: string; description?: string }> | undefined)?.[emailId]
  if (failed?.type === 'notFound') throw new EmailError('message_not_found', 'Message not found', 404)
  if (failed) throw new EmailError('mail_server_error', `Mail server rejected the change: ${failed.description ?? failed.type}`, 502)
}

/**
 * Applies a change to a whole conversation: `seen` to every message in it, a folder move to the messages that
 * share a folder with `emailId` (so a thread archived from the inbox leaves its copies in Sent alone).
 */
export async function updateThreadOf(
  env: StalwartEnv,
  accountId: string,
  emailId: string,
  patch: { seen?: boolean; folderId?: string },
): Promise<void> {
  const [, , found] = await mail(env, [
    ['Email/get', { accountId, ids: [emailId], properties: ['threadId'] }],
    ['Thread/get', { accountId, '#ids': { resultOf: 'c0', name: 'Email/get', path: '/list/*/threadId' } }],
    [
      'Email/get',
      { accountId, '#ids': { resultOf: 'c1', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['mailboxIds', 'keywords'] },
    ],
  ])
  const emails = (found!.list as { id: string; mailboxIds: Record<string, true>; keywords: Record<string, true> }[]) ?? []
  const self = emails.find((e) => e.id === emailId)
  if (!self) throw new EmailError('message_not_found', 'Message not found', 404)
  const update: Record<string, JmapArgs> = {}
  for (const e of emails) {
    const u: JmapArgs = {}
    if (patch.seen !== undefined && !!e.keywords.$seen !== patch.seen) u['keywords/$seen'] = patch.seen || null
    const sameFolder = Object.keys(e.mailboxIds).some((id) => self.mailboxIds[id])
    if (patch.folderId && sameFolder && !e.mailboxIds[patch.folderId]) u.mailboxIds = { [patch.folderId]: true }
    if (Object.keys(u).length) update[e.id] = u
  }
  if (!Object.keys(update).length) return
  const [result] = await mail(env, [['Email/set', { accountId, update }]])
  const failed = Object.values((result!.notUpdated as Record<string, { type?: string; description?: string }> | undefined) ?? {})[0]
  if (failed) throw new EmailError('mail_server_error', `Mail server rejected the change: ${failed.description ?? failed.type}`, 502)
}

/** The current Email state string of each account. It changes whenever any message in the account changes. */
export async function getEmailStates(env: StalwartEnv, accountIds: string[]): Promise<Map<string, string>> {
  if (!accountIds.length) return new Map()
  const results = await mail(env, accountIds.map((accountId) => ['Email/get', { accountId, ids: [] }]))
  return new Map(accountIds.map((id, i) => [id, String(results[i]!.state ?? '')]))
}

export type EmailChanges = {
  oldState: string
  newState: string
  hasMoreChanges: boolean
  created: string[]
  updated: string[]
  destroyed: string[]
}

/**
 * What changed in an account's mail since `sinceState`, at most `maxChanges` ids per call (call again while
 * hasMoreChanges). Returns null when the server can no longer calculate changes from that state (too old), so
 * the caller has to resync from scratch.
 */
export async function emailChanges(
  env: StalwartEnv,
  accountId: string,
  sinceState: string,
  maxChanges = 200,
): Promise<EmailChanges | null> {
  try {
    const [result] = await mail(env, [['Email/changes', { accountId, sinceState, maxChanges }]])
    return result as unknown as EmailChanges
  } catch (err) {
    if (err instanceof EmailError && /cannotCalculateChanges/i.test(err.message)) return null
    throw err
  }
}

/** Ids of every message with attachments in the account, newest first, a page at a time (for the first sync). */
export async function queryEmailsWithAttachments(env: StalwartEnv, accountId: string, position: number, limit: number) {
  const [result] = await mail(env, [
    [
      'Email/query',
      { accountId, filter: { hasAttachment: true }, sort: [{ property: 'receivedAt', isAscending: false }], position, limit },
    ],
  ])
  return { ids: (result!.ids as string[]) ?? [], total: Number(result!.total ?? 0) }
}

/** Ids of every message in the account, newest first, a page at a time (for search's first pass over a mailbox). */
export async function queryAllEmails(env: StalwartEnv, accountId: string, position: number, limit: number) {
  const [result] = await mail(env, [
    ['Email/query', { accountId, sort: [{ property: 'receivedAt', isAscending: false }], position, limit }],
  ])
  return { ids: (result!.ids as string[]) ?? [], total: Number(result!.total ?? 0) }
}

export type JmapEmailText = Pick<JmapEmail, 'id' | 'threadId' | 'mailboxIds' | 'from' | 'to' | 'subject' | 'receivedAt' | 'textBody' | 'htmlBody' | 'bodyValues'>

/** Body text over this is cut: search indexes the first 200 KB of a message, which is far past any real letter. */
const MAX_INDEXED_BODY_BYTES = 200_000

/** Messages with their headers and body text, for search. Missing ids (deleted meanwhile) are left out. */
export async function getEmailTexts(env: StalwartEnv, accountId: string, ids: string[]): Promise<JmapEmailText[]> {
  if (!ids.length) return []
  const [result] = await mail(env, [
    [
      'Email/get',
      {
        accountId,
        ids,
        properties: ['id', 'threadId', 'mailboxIds', 'from', 'to', 'subject', 'receivedAt', 'textBody', 'htmlBody', 'bodyValues'],
        bodyProperties: ['partId', 'type'],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: MAX_INDEXED_BODY_BYTES,
      },
    ],
  ])
  return (result!.list as JmapEmailText[]) ?? []
}

/** Just which folders each message sits in. Missing ids are left out. */
export async function getEmailFolders(env: StalwartEnv, accountId: string, ids: string[]): Promise<{ id: string; mailboxIds: Record<string, true> }[]> {
  if (!ids.length) return []
  const [result] = await mail(env, [['Email/get', { accountId, ids, properties: ['id', 'mailboxIds'] }]])
  return (result!.list as { id: string; mailboxIds: Record<string, true> }[]) ?? []
}

export type JmapAttachmentMessage = {
  id: string
  threadId: string
  mailboxIds: Record<string, true>
  receivedAt: string
  attachments: JmapBodyPart[]
}

/** Messages with just what attachment copying needs. Missing ids (deleted meanwhile) are left out. */
export async function getAttachmentParts(env: StalwartEnv, accountId: string, ids: string[]): Promise<JmapAttachmentMessage[]> {
  if (!ids.length) return []
  const [result] = await mail(env, [
    [
      'Email/get',
      { accountId, ids, properties: ['id', 'threadId', 'mailboxIds', 'receivedAt', 'attachments'], bodyProperties: PART },
    ],
  ])
  return (result!.list as JmapAttachmentMessage[]) ?? []
}

export type JmapIdentity = { id: string; name: string; email: string }

/** The account's sending identities (each one a From address it may use). */
export async function getIdentities(env: StalwartEnv, accountId: string): Promise<JmapIdentity[]> {
  const [result] = await mail(env, [['Identity/get', { accountId }]])
  return (result!.list as JmapIdentity[]) ?? []
}

export async function createIdentity(env: StalwartEnv, accountId: string, identity: { name: string; email: string }): Promise<string> {
  const [result] = await mail(env, [['Identity/set', { accountId, create: { i: identity } }]])
  const id = (result!.created as Record<string, { id: string }> | undefined)?.i?.id
  if (!id) throw setFailure('identity', (result!.notCreated as Record<string, SetError> | undefined)?.i)
  return id
}

/** Uploads bytes to the account (an attachment for a message about to be sent). The blob expires if unused. */
export async function uploadBlob(
  env: StalwartEnv,
  accountId: string,
  body: ReadableStream | ArrayBuffer | Uint8Array,
  contentType: string,
  size?: number,
): Promise<{ blobId: string; type: string; size: number }> {
  const headers = new Headers({ Authorization: `Bearer ${env.STALWART_API_KEY}`, 'Content-Type': contentType })
  if (size !== undefined) headers.set('Content-Length', String(size))
  const res = await fetch(new URL(`/jmap/upload/${encodeURIComponent(accountId)}/`, env.STALWART_URL), {
    method: 'POST',
    headers,
    body,
  })
  if (res.status === 413) throw new EmailError('attachment_too_large', 'That file is larger than the mail server accepts', 400)
  if (!res.ok) throw new EmailError('mail_server_error', `Upload failed with HTTP ${res.status}`, 502)
  return (await res.json()) as { blobId: string; type: string; size: number }
}

export type ReplySource = {
  id: string
  messageId: string[] | null
  references: string[] | null
  subject: string | null
  from: JmapAddress[] | null
  replyTo: JmapAddress[] | null
  to: JmapAddress[] | null
  cc: JmapAddress[] | null
  receivedAt: string
  attachments: JmapBodyPart[]
}

/** What a reply or forward needs from the original message, or null if it no longer exists. */
export async function getReplySource(env: StalwartEnv, accountId: string, emailId: string): Promise<ReplySource | null> {
  const [result] = await mail(env, [
    [
      'Email/get',
      {
        accountId,
        ids: [emailId],
        properties: ['id', 'messageId', 'references', 'subject', 'from', 'replyTo', 'to', 'cc', 'receivedAt', 'attachments'],
        bodyProperties: PART,
      },
    ],
  ])
  return ((result!.list as ReplySource[]) ?? [])[0] ?? null
}

/**
 * Creates the message in Drafts and submits it in one request. On success Stalwart moves it to Sent and clears
 * $draft. Returns the new message and thread ids.
 */
export async function submitEmail(
  env: StalwartEnv,
  accountId: string,
  options: { identityId: string; draftsId: string; sentId: string; email: JmapArgs },
): Promise<{ id: string; threadId: string }> {
  const results = await mail(env, [
    ['Email/set', { accountId, create: { m: { ...options.email, mailboxIds: { [options.draftsId]: true }, keywords: { $draft: true, $seen: true } } } }],
    [
      'EmailSubmission/set',
      {
        accountId,
        create: { s: { identityId: options.identityId, emailId: '#m' } },
        onSuccessUpdateEmail: {
          '#s': { [`mailboxIds/${options.draftsId}`]: null, [`mailboxIds/${options.sentId}`]: true, 'keywords/$draft': null },
        },
      },
    ],
  ])
  const created = (results[0]!.created as Record<string, { id: string; threadId: string }> | undefined)?.m
  if (!created) throw setFailure('message', (results[0]!.notCreated as Record<string, SetError> | undefined)?.m)
  const submitted = (results[1]!.created as Record<string, unknown> | undefined)?.s
  if (!submitted) {
    const err = (results[1]!.notCreated as Record<string, SetError> | undefined)?.s
    // Leave nothing behind in Drafts that the person didn't write as a draft.
    await mail(env, [['Email/set', { accountId, destroy: [created.id] }]]).catch(() => null)
    throw setFailure('submission', err)
  }
  return { id: created.id, threadId: created.threadId }
}

/** Creates a message in Drafts (marked $draft) without submitting it. */
export async function createDraft(env: StalwartEnv, accountId: string, draftsId: string, email: JmapArgs): Promise<{ id: string; threadId: string }> {
  const [result] = await mail(env, [
    ['Email/set', { accountId, create: { d: { ...email, mailboxIds: { [draftsId]: true }, keywords: { $draft: true, $seen: true } } } }],
  ])
  const created = (result!.created as Record<string, { id: string; threadId: string }> | undefined)?.d
  if (!created) throw setFailure('draft', (result!.notCreated as Record<string, SetError> | undefined)?.d)
  return { id: created.id, threadId: created.threadId }
}

/** Adds a keyword ($answered, $forwarded) to a message; a missing message is ignored. */
export async function addKeyword(env: StalwartEnv, accountId: string, emailId: string, keyword: string): Promise<void> {
  await mail(env, [['Email/set', { accountId, update: { [emailId]: { [`keywords/${keyword}`]: true } } }]])
}

type SetError = { type?: string; description?: string; properties?: string[] }

function setFailure(what: string, error: SetError | undefined): EmailError {
  const detail = error?.description ?? error?.type ?? 'unknown error'
  const props = error?.properties?.length ? ` (${error.properties.join(', ')})` : ''
  if (error?.type === 'forbiddenFrom') return new EmailError('forbidden_from', 'This mailbox may not send from that address', 403)
  if (error?.type === 'tooManyRecipients') return new EmailError('too_many_recipients', 'Too many recipients', 400)
  if (error?.type === 'noRecipients') return new EmailError('no_recipients', 'Add at least one recipient', 400)
  if (error?.type === 'invalidRecipients') return new EmailError('invalid_recipients', `Invalid recipients${props}`, 400)
  if (error?.type === 'tooLarge') return new EmailError('message_too_large', 'The message is too large to send', 400)
  if (error?.type === 'invalidProperties') return new EmailError('invalid_message', `${detail}${props}`, 400)
  return new EmailError('mail_server_error', `Mail server rejected the ${what}: ${detail}${props}`, 502)
}

/** Streams a blob (an attachment) from the account. */
export async function downloadBlob(env: StalwartEnv, accountId: string, blobId: string, name: string, type: string) {
  const url = new URL(
    `/jmap/download/${encodeURIComponent(accountId)}/${encodeURIComponent(blobId)}/${encodeURIComponent(name)}`,
    env.STALWART_URL,
  )
  url.searchParams.set('accept', type)
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.STALWART_API_KEY}` } })
  if (res.status === 404) throw new EmailError('attachment_not_found', 'Attachment not found', 404)
  if (!res.ok || !res.body) throw new EmailError('mail_server_error', `Mail server returned HTTP ${res.status}`, 502)
  return res
}

export type ImportEmail = {
  /** From uploadBlob: the raw message (RFC 5322), as fetched from the other provider. */
  blobId: string
  folderIds: string[]
  /** JMAP keywords: $seen, $flagged, $draft, $answered… */
  keywords: string[]
  /** When the original provider received it. Sorting and "received" dates use this. */
  receivedAt: string
}

export type ImportResult =
  | { ok: true; id: string; threadId: string; size: number }
  /** `existingId`: only if the server reports the message as already there (Stalwart 1.0 doesn't). */
  | { ok: false; type: string; description: string; existingId?: string }

/**
 * Puts already-uploaded raw messages into the account as they are (RFC 8621 Email/import): no sending, no filters,
 * the original received date kept. One result per input, in the same order. A batch should stay within the
 * server's maxObjectsInSet (see getLimits).
 *
 * Not idempotent: Stalwart 1.0.2 imports the same message again as a second copy (checked 2026-11-08), so callers
 * must remember what they've imported and skip it on a retry.
 */
export async function importEmails(env: StalwartEnv, accountId: string, emails: ImportEmail[]): Promise<ImportResult[]> {
  if (!emails.length) return []
  const [result] = await mail(env, [
    [
      'Email/import',
      {
        accountId,
        emails: Object.fromEntries(
          emails.map((e, i) => [
            `e${i}`,
            {
              blobId: e.blobId,
              mailboxIds: Object.fromEntries(e.folderIds.map((id) => [id, true])),
              keywords: Object.fromEntries(e.keywords.map((k) => [k, true])),
              receivedAt: e.receivedAt,
            },
          ]),
        ),
      },
    ],
  ])
  const created = (result!.created as Record<string, { id: string; threadId: string; size: number }> | null) ?? {}
  const failed = (result!.notCreated as Record<string, SetError & { existingId?: string }> | null) ?? {}
  return emails.map((_, i) => {
    const ok = created[`e${i}`]
    if (ok) return { ok: true, id: ok.id, threadId: ok.threadId, size: ok.size }
    const err = failed[`e${i}`]
    return {
      ok: false,
      type: err?.type ?? 'unknown',
      description: err?.description ?? err?.type ?? 'Not imported',
      ...(err?.existingId && { existingId: err.existingId }),
    }
  })
}

export type MailLimits = {
  /** Largest blob (so largest raw message) one upload may be. */
  maxSizeUpload: number
  /** Most objects one /set or /import call may create. */
  maxObjectsInSet: number
  maxCallsInRequest: number
  maxConcurrentUpload: number
  /** Largest total size of a message's attachments, when the server says. */
  maxSizeAttachmentsPerEmail: number | null
}

/** The server's JMAP limits, from its session object. Imports size their batches and skip messages by these. */
export async function getLimits(env: StalwartEnv): Promise<MailLimits> {
  const res = await fetch(new URL('/jmap/session', env.STALWART_URL), {
    headers: { Authorization: `Bearer ${env.STALWART_API_KEY}` },
  })
  if (!res.ok) throw new EmailError('mail_server_error', `Mail server returned HTTP ${res.status} for its session`, 502)
  const session = (await res.json()) as {
    capabilities: Record<string, Record<string, unknown>>
    accounts?: Record<string, { accountCapabilities?: Record<string, Record<string, unknown>> }>
  }
  const core = session.capabilities['urn:ietf:params:jmap:core'] ?? {}
  const mailCaps = Object.values(session.accounts ?? {})[0]?.accountCapabilities?.['urn:ietf:params:jmap:mail'] ?? {}
  const n = (v: unknown, fallback: number) => (typeof v === 'number' && v > 0 ? v : fallback)
  return {
    maxSizeUpload: n(core.maxSizeUpload, 50_000_000),
    maxObjectsInSet: n(core.maxObjectsInSet, 500),
    maxCallsInRequest: n(core.maxCallsInRequest, 16),
    maxConcurrentUpload: n(core.maxConcurrentUpload, 4),
    maxSizeAttachmentsPerEmail: typeof mailCaps.maxSizeAttachmentsPerEmail === 'number' ? mailCaps.maxSizeAttachmentsPerEmail : null,
  }
}

/** Puts a message in exactly these folders with exactly these keywords (the final pass: labels changed in Gmail). */
/** Moves messages and sets their keywords, many in one call. Returns how many Stalwart updated. */
export async function setEmailPlacements(env: StalwartEnv, accountId: string, placements: Record<string, { folderIds: string[]; keywords: string[] }>): Promise<number> {
  const ids = Object.keys(placements)
  if (!ids.length) return 0
  let updated = 0
  // Stalwart caps Email/set at a few hundred objects per call.
  for (let i = 0; i < ids.length; i += 200) {
    const update = Object.fromEntries(
      ids.slice(i, i + 200).map((id) => [
        id,
        {
          mailboxIds: Object.fromEntries(placements[id]!.folderIds.map((f) => [f, true])),
          keywords: Object.fromEntries(placements[id]!.keywords.map((k) => [k, true])),
        },
      ]),
    )
    const [result] = await mail(env, [['Email/set', { accountId, update }]])
    // JMAP reports a successful update as `updated: { <id>: null }`.
    updated += Object.keys((result!.updated as Record<string, unknown> | null) ?? {}).length
  }
  return updated
}

/** A new message as an email trigger sees it: who and what, the headers that mark automated mail, and its text. */
export type TriggerEmail = {
  id: string
  threadId: string
  mailboxIds: Record<string, true>
  keywords: Record<string, true>
  from: JmapAddress[] | null
  to: JmapAddress[] | null
  cc: JmapAddress[] | null
  subject: string | null
  receivedAt: string
  hasAttachment: boolean
  preview: string
  textBody: { partId: string | null }[]
  bodyValues: Record<string, { value: string; isTruncated: boolean }>
  'header:Auto-Submitted:asText': string | null
  'header:Precedence:asText': string | null
  'header:List-Id:asText': string | null
  'header:List-Unsubscribe:asURLs': string[] | null
  'header:X-Autoreply:asText': string | null
}

/** Messages for email triggers (agents/email-trigger.ts), with up to `maxBodyBytes` of plain text. */
export async function getTriggerEmails(env: StalwartEnv, accountId: string, ids: string[], maxBodyBytes = 16_000): Promise<TriggerEmail[]> {
  if (!ids.length) return []
  const [result] = await mail(env, [
    [
      'Email/get',
      {
        accountId,
        ids,
        properties: [
          'id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'subject', 'receivedAt', 'hasAttachment', 'preview',
          'textBody', 'bodyValues',
          'header:Auto-Submitted:asText', 'header:Precedence:asText', 'header:List-Id:asText',
          'header:List-Unsubscribe:asURLs', 'header:X-Autoreply:asText',
        ],
        bodyProperties: ['partId'],
        fetchTextBodyValues: true,
        maxBodyValueBytes: maxBodyBytes,
      },
    ],
  ])
  return (result!.list as TriggerEmail[]) ?? []
}

/** The newest messages in a folder (ids only), for a trigger's test event. */
export async function newestIn(env: StalwartEnv, accountId: string, folderId: string, limit = 1): Promise<string[]> {
  const [result] = await mail(env, [
    ['Email/query', { accountId, filter: { inMailbox: folderId }, sort: [{ property: 'receivedAt', isAscending: false }], limit }],
  ])
  return (result!.ids as string[]) ?? []
}
