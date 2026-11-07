// Storage: folders and files in the organization's R2 bucket, shared with the rules in roles.ts, plus the
// read-only "Mail Attachments" folder made from the attachments mail-sync copies. See migrations/0006_storage.sql.
//
// Every read goes through a chain lookup (the item and its ancestors in one query), so access is checked on each
// request against the current tree and grants. Bytes go through the Worker for viewers and editors (the desktop
// app's app:// origin can't pass R2's CORS rules), and downloads use short-lived presigned URLs.

import * as filesDb from '../db/files'
import type { FileRow } from '../db/files'
import * as membersDb from '../db/members'
import type { Member } from '../db/members'
import * as storageDb from '../db/storage'
import type { ItemView, OrgAccess, Space, StorageRole } from '../db/storage'
import { ApiError } from '../errors'
import { isAdmin, mailContext, readableMailboxes } from '../mailserver/access'
import type { Actor, EmailEnv } from '../mailserver/types'
import { organizationBucket, type BucketEnv } from './buckets'
import { cleanFileName } from './files'
import { copyObject, deleteObject, getObject, presign, putObject } from './r2'
import { atLeast, canRemove, chainRoles, childRole, hiddenAbove, inTrash, roleOn, type Reader, type Role } from './roles'
import { extractText, textKind } from '../search/extract'
import { enqueueIndex } from '../search/jobs'

export type StorageEnv = BucketEnv & EmailEnv & Pick<Env, 'SEARCH_INDEX' | 'AI'>

/** Workers accept request bodies up to 100 MB; bigger uploads would need multipart uploads to R2. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
/** Largest file agents can read or write as text. */
const MAX_TEXT_BYTES = 1024 * 1024
const DOWNLOAD_SECONDS = 300
/** How long trashed items stay before they're deleted for good. */
export const TRASH_DAYS = 30

// ---------------------------------------------------------------------------------------------------------------
// Shapes returned by the API

export type StorageItem = {
  id: string
  organizationId: string
  space: Space
  parentId: string | null
  kind: 'folder' | 'file'
  name: string
  contentType: string | null
  size: number
  version: number
  /** What everyone in the organization gets on this item itself (not counting folders above). */
  orgAccess: OrgAccess | null
  /** Shared with anyone beyond its owner, on this item itself. */
  shared: boolean
  /** People with a grant on this item itself. */
  people: number
  /** Has a public link of its own ("Anyone with the link can view"). */
  publicLink: boolean
  /** The reader's role. */
  role: StorageRole
  owner: { memberId: string; name: string | null; email: string } | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  trashedAt: string | null
}

export type PathEntry = { id: string; name: string }

export type MailAttachment = {
  id: string
  mailboxId: string
  name: string
  contentType: string
  size: number
  source: 'received' | 'sent'
  emailId: string | null
  threadId: string | null
  createdAt: string
}

function toItem(row: ItemView, role: StorageRole): StorageItem {
  return {
    id: row.id,
    organizationId: row.organization_id,
    space: row.space,
    parentId: row.parent_id,
    kind: row.kind,
    name: row.name,
    contentType: row.content_type,
    size: row.size_bytes,
    version: row.version,
    orgAccess: row.org_access,
    shared: row.grant_count > 0 || !!row.org_access || !!row.has_link,
    people: row.grant_count,
    publicLink: !!row.has_link,
    role,
    owner: row.owner_member_id && row.owner_email
      ? { memberId: row.owner_member_id, name: row.owner_name, email: row.owner_email }
      : null,
    updatedBy: row.updated_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trashedAt: row.trashed_at,
  }
}

function toAttachment(row: FileRow): MailAttachment {
  return {
    id: row.id,
    mailboxId: row.mailbox_id!,
    name: row.name,
    contentType: row.content_type,
    size: row.size_bytes,
    source: row.source === 'sent' ? 'sent' : 'received',
    emailId: row.email_id,
    threadId: row.thread_id,
    createdAt: row.created_at,
  }
}

const sortItems = <T extends { kind: 'folder' | 'file'; name: string }>(items: T[]) =>
  items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'folder' ? -1 : 1))

// ---------------------------------------------------------------------------------------------------------------
// Errors and access

const notFound = (what = 'item') => new ApiError(`${what}_not_found`, `${what[0]!.toUpperCase()}${what.slice(1)} not found`, 404)
const forbidden = (message: string) => new ApiError('forbidden', message, 403)

async function memberOf(env: StorageEnv, organizationId: string, actor: Actor): Promise<Member> {
  const member = await membersDb.find(env.DB, organizationId, actor.userId)
  // Same answer as a missing organization, so non-members can't probe which organizations exist.
  if (!member) throw notFound('organization')
  return member
}

const readerOf = (member: Member): Reader => ({ memberId: member.id, admin: isAdmin(member) })

type ItemContext = {
  item: ItemView
  chain: (ItemView & { depth: number })[]
  member: Member
  reader: Reader
  role: StorageRole
}

/**
 * Loads an item and checks the actor has at least `need` on it. Someone with no access gets 404, as for a missing
 * item. Items in the trash (or inside a trashed folder) are only found with `trashed: true`.
 */
async function itemContext(
  env: StorageEnv,
  actor: Actor,
  itemId: string,
  need: StorageRole,
  options: { trashed?: boolean } = {},
): Promise<ItemContext> {
  const chain = await storageDb.chain(env.DB, itemId, actor.userId)
  const item = chain[0]
  if (!item) throw notFound()
  const member = await membersDb.find(env.DB, item.organization_id, actor.userId)
  if (!member) throw notFound()
  const reader = readerOf(member)
  const role = roleOn(chain, reader)
  if (!role) throw notFound()
  if (!options.trashed && inTrash(chain)) throw notFound()
  if (!atLeast(role, need)) {
    throw forbidden(need === 'viewer' ? "You can't open this" : need === 'editor' ? 'You can only view this' : "You can't manage this")
  }
  return { item, chain, member, reader, role }
}

/** The breadcrumb to an item: the folders above it that the reader can see, top first, then the item. */
function pathOf(ctx: Pick<ItemContext, 'chain' | 'reader'>): PathEntry[] {
  const visible = ctx.chain.slice(0, ctx.chain.length - hiddenAbove(ctx.chain, ctx.reader))
  return visible.reverse().map((n) => ({ id: n.id, name: n.name }))
}

type Target = { organizationId: string; space: Space; parentId: string | null; member: Member; reader: Reader }

/**
 * Where something is being put: a folder the actor can edit, or the top of a space. Anyone in the organization may
 * add to the top of the organization space and of their own My Files.
 */
async function targetContext(
  env: StorageEnv,
  actor: Actor,
  organizationId: string,
  where: { parentId?: string | null; space?: Space },
): Promise<Target> {
  if (where.parentId) {
    const ctx = await itemContext(env, actor, where.parentId, 'editor')
    if (ctx.item.kind !== 'folder') throw new ApiError('not_a_folder', 'Files can only go in folders')
    if (ctx.item.organization_id !== organizationId) throw notFound('folder')
    return { organizationId, space: ctx.item.space, parentId: ctx.item.id, member: ctx.member, reader: ctx.reader }
  }
  const member = await memberOf(env, organizationId, actor)
  return { organizationId, space: where.space ?? 'personal', parentId: null, member, reader: readerOf(member) }
}

/** Cleans a name for a file or folder. */
function cleanName(name: string): string {
  const cleaned = cleanFileName(name)
  if (cleaned === '.' || cleaned === '..') throw new ApiError('invalid_name', 'Choose another name')
  return cleaned
}

/** `name`, or `name (2).ext`, `name (3).ext`… whichever is free in the target. */
async function freeName(env: StorageEnv, target: Target, name: string): Promise<string> {
  const where = { organizationId: target.organizationId, space: target.space, parentId: target.parentId, ownerMemberId: target.member.id }
  if (!(await storageDb.nameTaken(env.DB, where, name))) return name
  const dot = name.lastIndexOf('.')
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})${ext}`
    if (!(await storageDb.nameTaken(env.DB, where, candidate))) return candidate
  }
  throw new ApiError('name_taken', `Too many items named ${name} here`, 409)
}

async function requireFreeName(env: StorageEnv, target: Target, name: string, exceptId = ''): Promise<void> {
  const where = { organizationId: target.organizationId, space: target.space, parentId: target.parentId, ownerMemberId: target.member.id }
  if (await storageDb.nameTaken(env.DB, where, name, exceptId)) {
    throw new ApiError('name_taken', `There's already something called ${name} here`, 409)
  }
}

const isUniqueViolation = (err: unknown) => err instanceof Error && /UNIQUE constraint failed/i.test(err.message)

// ---------------------------------------------------------------------------------------------------------------
// Listing

export type TopView = 'personal' | 'organization' | 'shared' | 'trash'

/** The top of a view: My Files, the organization's folders, what's shared with you, or your trash. */
export async function listTop(env: StorageEnv, actor: Actor, organizationId: string, view: TopView): Promise<StorageItem[]> {
  const member = await memberOf(env, organizationId, actor)
  const reader = readerOf(member)
  if (view === 'personal') {
    const rows = await storageDb.personalTop(env.DB, organizationId, member.id, actor.userId)
    return sortItems(rows.map((r) => toItem(r, 'manager')))
  }
  if (view === 'organization') {
    const rows = await storageDb.organizationTop(env.DB, organizationId, actor.userId)
    return sortItems(rows.flatMap((r) => {
      const role = roleOn([r], reader)
      return role ? [toItem(r, role)] : []
    }))
  }
  // Shared and trash rows need their whole chain: what's above them can add roles, or be trashed.
  const rows = view === 'shared'
    ? await storageDb.sharedWith(env.DB, organizationId, member.id, actor.userId)
    : await storageDb.trash(env.DB, organizationId, member.id, actor.userId)
  const items: StorageItem[] = []
  for (const row of rows) {
    const chain = await storageDb.chain(env.DB, row.id, actor.userId)
    const role = roleOn(chain, reader)
    if (!role) continue
    if (view === 'shared') {
      if (inTrash(chain)) continue
      // Shown once, at the highest point it was shared from: skip items inside a folder that's also shared with you.
      const roles = chainRoles(chain, reader)
      if (roles.slice(1).some(Boolean)) continue
    } else if (inTrash(chain.slice(1))) {
      continue // inside a trashed folder: restoring the folder brings it back
    }
    items.push(toItem(row, role))
  }
  return view === 'trash' ? items : sortItems(items)
}

/** A folder's contents and the breadcrumb to it. */
export async function getFolder(env: StorageEnv, actor: Actor, folderId: string) {
  const ctx = await itemContext(env, actor, folderId, 'viewer')
  if (ctx.item.kind !== 'folder') throw new ApiError('not_a_folder', 'This is a file, not a folder')
  const rows = await storageDb.children(env.DB, ctx.item.id, actor.userId)
  return {
    folder: toItem(ctx.item, ctx.role),
    path: pathOf(ctx),
    items: sortItems(rows.map((r) => toItem(r, childRole(ctx.role, r, ctx.reader)!))),
  }
}

export async function getItem(env: StorageEnv, actor: Actor, itemId: string) {
  const ctx = await itemContext(env, actor, itemId, 'viewer', { trashed: true })
  return { item: toItem(ctx.item, ctx.role), path: pathOf(ctx), trashed: inTrash(ctx.chain) }
}

// ---------------------------------------------------------------------------------------------------------------
// Creating

export async function createFolder(
  env: StorageEnv,
  actor: Actor,
  organizationId: string,
  input: { name: string; parentId?: string | null; space?: Space },
): Promise<StorageItem> {
  const target = await targetContext(env, actor, organizationId, input)
  const name = cleanName(input.name)
  await requireFreeName(env, target, name)
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await storageDb
    .insert(env.DB, {
      id,
      organization_id: organizationId,
      space: target.space,
      parent_id: target.parentId,
      kind: 'folder',
      name,
      owner_member_id: target.member.id,
      // A new team folder is visible to the whole organization; anything else starts with what's above it.
      org_access: target.space === 'organization' && !target.parentId ? 'viewer' : null,
      file_id: null,
      version: 0,
      size_bytes: 0,
      content_type: null,
      created_by: actor.userId,
      created_at: now,
      updated_by: actor.userId,
      updated_at: now,
    })
    .run()
    .catch((err) => {
      throw isUniqueViolation(err) ? new ApiError('name_taken', `There's already something called ${name} here`, 409) : err
    })
  return (await getItem(env, actor, id)).item
}

export type Upload = { name: string; contentType: string; size: number; body: ReadableStream | Uint8Array | string }

/** Stores a new file. A name already used in the folder gets a number: "report (2).csv". */
export async function uploadFile(
  env: StorageEnv,
  actor: Actor,
  organizationId: string,
  where: { parentId?: string | null; space?: Space },
  upload: Upload,
): Promise<StorageItem> {
  checkSize(upload.size)
  const target = await targetContext(env, actor, organizationId, where)
  const name = await freeName(env, target, cleanName(upload.name))
  const contentType = contentTypeFor(name, upload.contentType)
  const itemId = crypto.randomUUID()
  const bucket = await organizationBucket(env, organizationId)
  const stored = await storeVersion(env, bucket, { itemId, name, contentType, size: upload.size, body: upload.body })
  const now = new Date().toISOString()
  try {
    await env.DB.batch([
      filesDb.insert(env.DB, versionRow(organizationId, itemId, 1, stored, name, contentType, actor.userId, now)),
      storageDb.insert(env.DB, {
        id: itemId,
        organization_id: organizationId,
        space: target.space,
        parent_id: target.parentId,
        kind: 'file',
        name,
        owner_member_id: target.member.id,
        org_access: null,
        file_id: stored.fileId,
        version: 1,
        size_bytes: stored.size,
        content_type: contentType,
        created_by: actor.userId,
        created_at: now,
        updated_by: actor.userId,
        updated_at: now,
      }),
    ])
  } catch (err) {
    await deleteObject(env, bucket, stored.key).catch(() => null)
    if (isUniqueViolation(err)) throw new ApiError('name_taken', `Something called ${name} was just added here. Try again.`, 409)
    throw err
  }
  await enqueueIndex(env, [stored.fileId])
  return (await getItem(env, actor, itemId)).item
}

type Stored = { fileId: string; key: string; size: number; sha256: string }

/** Writes one version's bytes to R2, hashing them on the way. */
async function storeVersion(
  env: StorageEnv,
  bucket: string,
  v: { itemId: string; name: string; contentType: string; size: number; body: Upload['body'] },
): Promise<Stored> {
  const fileId = crypto.randomUUID()
  const key = `drive/${v.itemId}/${fileId}/${v.name}`
  const digest = new crypto.DigestStream('SHA-256')
  if (v.body instanceof ReadableStream) {
    const [toR2, toHash] = v.body.tee()
    const hashing = toHash.pipeTo(digest)
    await putObject(env, bucket, key, toR2, { contentType: v.contentType, size: v.size, metadata: { 'item-id': v.itemId } })
    await hashing
  } else {
    const bytes = typeof v.body === 'string' ? new TextEncoder().encode(v.body) : v.body
    const writer = digest.getWriter()
    await writer.write(bytes)
    await writer.close()
    await putObject(env, bucket, key, bytes, { contentType: v.contentType, metadata: { 'item-id': v.itemId } })
    v.size = bytes.byteLength
  }
  const sha256 = [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return { fileId, key, size: v.size, sha256 }
}

function versionRow(
  organizationId: string,
  itemId: string,
  version: number,
  stored: Stored,
  name: string,
  contentType: string,
  userId: string,
  now: string,
): filesDb.NewFile {
  return {
    id: stored.fileId,
    organization_id: organizationId,
    mailbox_id: null,
    r2_key: stored.key,
    name,
    content_type: contentType,
    size_bytes: stored.size,
    sha256: stored.sha256,
    source: 'drive',
    email_id: null,
    thread_id: null,
    part_id: null,
    stalwart_blob_id: null,
    disposition: null,
    content_id: null,
    item_id: itemId,
    version,
    created_by: userId,
    created_at: now,
  }
}

function checkSize(size: number): void {
  if (!Number.isFinite(size) || size < 0) throw new ApiError('length_required', 'Send the file size as Content-Length')
  if (size > MAX_UPLOAD_BYTES) throw new ApiError('file_too_large', 'Files can be up to 100 MB')
}

// ---------------------------------------------------------------------------------------------------------------
// Reading and saving contents

/**
 * A file's bytes, the current version or an earlier one. Always sent as a download that browsers won't render:
 * files are untrusted content, and the viewers read them with fetch.
 */
export async function readContent(env: StorageEnv, actor: Actor, itemId: string, version?: number): Promise<Response> {
  const ctx = await itemContext(env, actor, itemId, 'viewer')
  const file = await versionFile(env, ctx, version)
  return serveFile(env, file, ctx.item.name, { version: file.version ?? ctx.item.version })
}

async function versionFile(env: StorageEnv, ctx: ItemContext, version?: number): Promise<FileRow> {
  if (ctx.item.kind !== 'file') throw new ApiError('not_a_file', 'Folders have no contents to download')
  if (!version || version === ctx.item.version) {
    const current = await filesDb.find(env.DB, ctx.item.file_id!)
    if (!current) throw notFound('version')
    return current
  }
  // Only the earlier versions still kept (the last 5, each for 30 days), even if an older one's object hasn't
  // been purged yet.
  const kept = await filesDb.previousVersions(env.DB, ctx.item.id, ctx.item.file_id!)
  const file = kept.find((f) => f.version === version)
  if (!file) throw notFound('version')
  return file
}

async function serveFile(env: StorageEnv, file: FileRow, name: string, extra: { version?: number } = {}): Promise<Response> {
  const bucket = await organizationBucket(env, file.organization_id)
  const object = await getObject(env, bucket, file.r2_key)
  if (!object) throw notFound('file')
  const headers = new Headers({
    'Content-Type': file.content_type,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, no-store',
  })
  const length = object.headers.get('Content-Length')
  if (length) headers.set('Content-Length', length)
  if (extra.version) headers.set('ETag', `"${extra.version}"`)
  return new Response(object.body, { headers })
}

/**
 * Saves new contents as the next version. `expectedVersion` is the version the editor started from: if someone
 * saved in between, this fails with 409 version_conflict and nothing changes.
 */
export async function writeContent(
  env: StorageEnv,
  actor: Actor,
  itemId: string,
  expectedVersion: number,
  upload: Omit<Upload, 'name'>,
): Promise<StorageItem> {
  checkSize(upload.size)
  const ctx = await itemContext(env, actor, itemId, 'editor')
  if (ctx.item.kind !== 'file') throw new ApiError('not_a_file', 'Only files have contents')
  if (ctx.item.version !== expectedVersion) throw conflict()
  const bucket = await organizationBucket(env, ctx.item.organization_id)
  const contentType = ctx.item.content_type ?? contentTypeFor(ctx.item.name, upload.contentType)
  const stored = await storeVersion(env, bucket, { itemId, name: ctx.item.name, contentType, size: upload.size, body: upload.body })
  await commitVersion(env, ctx, bucket, stored, contentType, actor)
  return (await getItem(env, actor, itemId)).item
}

const conflict = () =>
  new ApiError('version_conflict', 'Someone else saved this file while you were editing. Reload to see their changes.', 409)

/** Makes a stored version current. The unique (item, version) index stops two saves from the same version. */
async function commitVersion(env: StorageEnv, ctx: ItemContext, bucket: string, stored: Stored, contentType: string, actor: Actor) {
  const now = new Date().toISOString()
  const next = ctx.item.version + 1
  try {
    const [, updated] = await env.DB.batch([
      filesDb.insert(env.DB, versionRow(ctx.item.organization_id, ctx.item.id, next, stored, ctx.item.name, contentType, actor.userId, now)),
      storageDb.setVersion(env.DB, ctx.item.id, {
        expectedVersion: ctx.item.version,
        version: next,
        fileId: stored.fileId,
        size: stored.size,
        contentType,
        userId: actor.userId,
        now,
      }),
      ...filesDb.retireVersions(env.DB, ctx.item.id, ctx.item.file_id!, now),
      filesDb.copySearchExcluded(env.DB, ctx.item.file_id!, stored.fileId),
    ])
    if (!updated!.meta.changes) throw conflict()
    await enqueueIndex(env, [stored.fileId])
  } catch (err) {
    await deleteObject(env, bucket, stored.key).catch(() => null)
    if (err instanceof ApiError) {
      await filesDb.remove(env.DB, stored.fileId).run().catch(() => null)
      throw err
    }
    throw isUniqueViolation(err) ? conflict() : err
  }
}

/** A short-lived link that downloads the file straight from R2. */
export async function downloadUrl(env: StorageEnv, actor: Actor, itemId: string, version?: number) {
  const ctx = await itemContext(env, actor, itemId, 'viewer')
  const file = await versionFile(env, ctx, version)
  const bucket = await organizationBucket(env, file.organization_id)
  const url = await presign(env, bucket, file.r2_key, { method: 'GET', expiresIn: DOWNLOAD_SECONDS, fileName: ctx.item.name })
  return { url, expiresAt: new Date(Date.now() + DOWNLOAD_SECONDS * 1000).toISOString() }
}

// Text, for agents

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-ndjson|csv|markdown))/
/** Largest PDF whose text agents can read; the text itself is cut at MAX_TEXT_BYTES. */
const MAX_PDF_BYTES = 25 * 1024 * 1024

export async function readText(env: StorageEnv, actor: Actor, itemId: string) {
  const ctx = await itemContext(env, actor, itemId, 'viewer')
  if (ctx.item.kind !== 'file') throw new ApiError('not_a_file', 'Folders have no contents')
  const pdf = textKind(ctx.item.content_type ?? '', ctx.item.name) === 'pdf'
  if (!pdf && !TEXT_TYPES.test(ctx.item.content_type ?? '')) throw new ApiError('not_text', `${ctx.item.name} isn't a text file`)
  if (ctx.item.size_bytes > (pdf ? MAX_PDF_BYTES : MAX_TEXT_BYTES)) {
    throw new ApiError('file_too_large', `${pdf ? 'PDFs over 25 MB' : 'Text files over 1 MB'} can only be downloaded`)
  }
  const res = await readContent(env, actor, itemId)
  if (!pdf) return { item: toItem(ctx.item, ctx.role), text: await res.text(), truncated: false }
  const text = await extractText(env.AI, 'pdf', ctx.item.name, await res.arrayBuffer())
  const truncated = text.length > MAX_TEXT_BYTES
  return { item: toItem(ctx.item, ctx.role), text: truncated ? text.slice(0, MAX_TEXT_BYTES) : text, truncated }
}

export async function writeText(env: StorageEnv, actor: Actor, itemId: string, expectedVersion: number, text: string) {
  const size = new TextEncoder().encode(text).byteLength
  if (size > MAX_TEXT_BYTES) throw new ApiError('file_too_large', 'Text files can be up to 1 MB here')
  return writeContent(env, actor, itemId, expectedVersion, { contentType: 'text/plain', size, body: text })
}

// ---------------------------------------------------------------------------------------------------------------
// Versions

export async function listVersions(env: StorageEnv, actor: Actor, itemId: string) {
  const ctx = await itemContext(env, actor, itemId, 'viewer')
  if (ctx.item.kind !== 'file') throw new ApiError('not_a_file', 'Folders have no versions')
  const rows = await filesDb.previousVersions(env.DB, ctx.item.id, ctx.item.file_id!)
  const current = await filesDb.find(env.DB, ctx.item.file_id!)
  const entry = (f: FileRow & { created_by_name?: string | null }, isCurrent: boolean) => ({
    version: f.version!,
    size: f.size_bytes,
    savedAt: f.created_at,
    savedBy: f.created_by_name ?? null,
    current: isCurrent,
    // When an earlier version is removed for good.
    expiresAt: isCurrent || !f.deleted_at
      ? null
      : new Date(Date.parse(f.deleted_at) + filesDb.VERSION_DAYS * 86_400_000).toISOString(),
  })
  return {
    versions: [
      ...(current ? [{ ...entry(current, true), savedBy: ctx.item.updated_by_name }] : []),
      ...rows.map((r) => entry(r, false)),
    ],
  }
}

/** Makes an earlier version current again, as a new version (the one it replaces is kept like any other). */
export async function restoreVersion(env: StorageEnv, actor: Actor, itemId: string, version: number) {
  const ctx = await itemContext(env, actor, itemId, 'editor')
  if (ctx.item.kind !== 'file') throw new ApiError('not_a_file', 'Folders have no versions')
  if (version === ctx.item.version) return toItem(ctx.item, ctx.role)
  const old = await versionFile(env, ctx, version)
  const bucket = await organizationBucket(env, ctx.item.organization_id)
  const fileId = crypto.randomUUID()
  const key = `drive/${ctx.item.id}/${fileId}/${ctx.item.name}`
  if (!(await copyObject(env, bucket, old.r2_key, key))) throw notFound('version')
  const stored = { fileId, key, size: old.size_bytes, sha256: old.sha256 ?? '' }
  await commitVersion(env, ctx, bucket, stored, old.content_type, actor)
  return (await getItem(env, actor, itemId)).item
}

// ---------------------------------------------------------------------------------------------------------------
// Renaming, moving, trash

export async function updateItem(
  env: StorageEnv,
  actor: Actor,
  itemId: string,
  input: { name?: string; parentId?: string | null; space?: Space },
): Promise<StorageItem> {
  const ctx = await itemContext(env, actor, itemId, 'editor')
  const moving = input.parentId !== undefined || input.space !== undefined
  const now = new Date().toISOString()
  const name = input.name === undefined ? ctx.item.name : cleanName(input.name)

  let target: Target = {
    organizationId: ctx.item.organization_id,
    space: ctx.item.space,
    parentId: ctx.item.parent_id,
    member: ctx.member,
    reader: ctx.reader,
  }
  if (moving) {
    if (!canRemove(ctx.chain, ctx.reader)) throw forbidden("You can't move this out of its folder")
    target = await targetContext(env, actor, ctx.item.organization_id, {
      parentId: input.parentId ?? null,
      space: input.parentId ? undefined : (input.space ?? ctx.item.space),
    })
    if (target.parentId) {
      // A folder can't go inside itself.
      const above = await storageDb.chain(env.DB, target.parentId, actor.userId)
      if (above.some((n) => n.id === ctx.item.id)) throw new ApiError('invalid_move', "A folder can't go inside itself")
    } else if (target.space === 'personal' && ctx.item.owner_member_id !== ctx.member.id) {
      // The top of My Files is yours alone; something you don't own would land in your space but stay theirs.
      throw new ApiError('invalid_move', 'Only its owner can move this to the top of My Files')
    }
  }
  // At the top of My Files, names are unique per owner, and the owner is the item's.
  const owner = ctx.item.owner_member_id && target.space === 'personal' && !target.parentId
    ? { ...target, member: { ...ctx.member, id: ctx.item.owner_member_id } }
    : target
  await requireFreeName(env, owner, name, ctx.item.id)

  const statements: D1PreparedStatement[] = []
  if (name !== ctx.item.name) statements.push(storageDb.rename(env.DB, ctx.item.id, name, actor.userId, now))
  if (moving && (target.parentId !== ctx.item.parent_id || target.space !== ctx.item.space)) {
    statements.push(...storageDb.move(env.DB, ctx.item.id, { space: target.space, parentId: target.parentId }, now))
  }
  if (statements.length) {
    await env.DB.batch(statements).catch((err) => {
      throw isUniqueViolation(err) ? new ApiError('name_taken', `There's already something called ${name} there`, 409) : err
    })
  }
  if (moving) {
    // Search filters on the top-level item above a file. A move under a different top (or to another space)
    // re-indexes everything inside; a move within the same top changes nothing the vectors carry.
    const oldTop = ctx.chain.at(-1)!.id
    const newTop = target.parentId ? (await storageDb.topOf(env.DB, target.parentId))?.top_id : ctx.item.id
    if (newTop !== oldTop || target.space !== ctx.item.space) {
      await enqueueIndex(env, await storageDb.subtreeFileIds(env.DB, ctx.item.id))
    }
  }
  return (await getItem(env, actor, itemId)).item
}

export async function trashItem(env: StorageEnv, actor: Actor, itemId: string): Promise<void> {
  const ctx = await itemContext(env, actor, itemId, 'editor')
  if (!canRemove(ctx.chain, ctx.reader)) throw forbidden("You can't remove this from its folder")
  await storageDb.setTrashed(env.DB, ctx.item.id, { at: new Date().toISOString(), by: actor.userId }).run()
}

/** Takes an item out of the trash, back where it was. If its name was taken meanwhile, it gets a number. */
export async function restoreItem(env: StorageEnv, actor: Actor, itemId: string): Promise<StorageItem> {
  const ctx = await itemContext(env, actor, itemId, 'viewer', { trashed: true })
  if (!ctx.item.trashed_at) {
    if (inTrash(ctx.chain)) throw new ApiError('parent_in_trash', 'Its folder is in the trash. Restore the folder instead.', 409)
    return toItem(ctx.item, ctx.role)
  }
  if (ctx.item.trashed_by !== actor.userId && !canRemove(ctx.chain, ctx.reader)) {
    throw forbidden("You can't restore this")
  }
  if (inTrash(ctx.chain.slice(1))) {
    throw new ApiError('parent_in_trash', 'Its folder is in the trash. Restore the folder instead.', 409)
  }
  const target: Target = {
    organizationId: ctx.item.organization_id,
    space: ctx.item.space,
    parentId: ctx.item.parent_id,
    member: { ...ctx.member, id: ctx.item.owner_member_id ?? ctx.member.id },
    reader: ctx.reader,
  }
  const name = await freeName(env, target, ctx.item.name)
  const now = new Date().toISOString()
  await env.DB.batch([
    ...(name !== ctx.item.name ? [storageDb.rename(env.DB, ctx.item.id, name, actor.userId, now)] : []),
    storageDb.setTrashed(env.DB, ctx.item.id, null),
  ])
  return (await getItem(env, actor, itemId)).item
}

/** Deletes a trashed item for good, with everything inside it. Only its managers can. */
export async function deleteItem(env: StorageEnv, actor: Actor, itemId: string): Promise<void> {
  const ctx = await itemContext(env, actor, itemId, 'manager', { trashed: true })
  if (!ctx.item.trashed_at) throw new ApiError('not_in_trash', 'Move it to the trash first')
  // The trigger marks every version inside for the purge, which removes the R2 objects within the hour.
  await storageDb.removeMany(env.DB, [ctx.item.id]).run()
}

/** Cron: deletes items that have been in the trash for TRASH_DAYS. */
export async function emptyExpiredTrash(env: Pick<Env, 'DB'>, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - TRASH_DAYS * 86_400_000).toISOString()
  const ids = await storageDb.listExpiredTrash(env.DB, before, 500)
  if (ids.length) await storageDb.removeMany(env.DB, ids).run()
  return ids.length
}

// ---------------------------------------------------------------------------------------------------------------
// Sharing

export async function listAccess(env: StorageEnv, actor: Actor, itemId: string) {
  const ctx = await itemContext(env, actor, itemId, 'viewer')
  const ids = ctx.chain.map((n) => n.id)
  const [grants, links] = await Promise.all([storageDb.grants(env.DB, ids), storageDb.links(env.DB, ids)])
  const own = links.find((l) => l.item_id === ctx.item.id)
  // The nearest folder above with a link: this item can be opened from that folder's link.
  const above = ctx.chain.slice(1).find((n) => links.some((l) => l.item_id === n.id))
  const names = new Map(ctx.chain.map((n) => [n.id, n.name]))
  // What folders above give, so the dialog can say "Editor, from Marketing".
  const inherited = ctx.chain.slice(1).flatMap((n) => {
    const fromOwner = n.owner_member_id && n.owner_email
      ? [{ memberId: n.owner_member_id, name: n.owner_name, email: n.owner_email, role: 'manager' as StorageRole, from: { id: n.id, name: n.name }, owner: true }]
      : []
    return fromOwner
  })
  const inheritedOrgAccess = ctx.chain.slice(1).reduce<{ access: OrgAccess; from: PathEntry } | null>(
    (best, n) => (n.org_access && (!best || (n.org_access === 'editor' && best.access === 'viewer'))
      ? { access: n.org_access, from: { id: n.id, name: n.name } }
      : best),
    null,
  )
  return {
    item: toItem(ctx.item, ctx.role),
    canManage: ctx.role === 'manager',
    owner: toItem(ctx.item, ctx.role).owner,
    orgAccess: ctx.item.org_access,
    inheritedOrgAccess,
    publicLink: own ? { token: own.token, createdAt: own.created_at, createdBy: own.created_by_name } : null,
    inheritedPublicLink: above ? { from: { id: above.id, name: above.name } } : null,
    grants: grants.filter((g) => g.item_id === ctx.item.id).map((g) => ({ memberId: g.member_id, name: g.name, email: g.email, role: g.role })),
    inherited: [
      ...inherited,
      ...grants
        .filter((g) => g.item_id !== ctx.item.id)
        .map((g) => ({ memberId: g.member_id, name: g.name, email: g.email, role: g.role, from: { id: g.item_id, name: names.get(g.item_id) ?? '' }, owner: false })),
    ],
  }
}

export async function setAccess(
  env: StorageEnv,
  actor: Actor,
  itemId: string,
  input: { orgAccess?: OrgAccess | null; publicLink?: boolean; grants?: { memberId: string; role: StorageRole | null }[] },
) {
  const ctx = await itemContext(env, actor, itemId, 'manager')
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = []
  if (input.orgAccess !== undefined) statements.push(storageDb.setOrgAccess(env.DB, ctx.item.id, input.orgAccess))
  if (input.publicLink === true) {
    statements.push(
      storageDb.insertLink(env.DB, { token: linkToken(), item_id: ctx.item.id, organization_id: ctx.item.organization_id, created_by: actor.userId, created_at: now }),
    )
  } else if (input.publicLink === false) {
    statements.push(storageDb.removeLink(env.DB, ctx.item.id))
  }
  for (const g of input.grants ?? []) {
    if (!(await membersDb.exists(env.DB, g.memberId, ctx.item.organization_id))) throw notFound('member')
    if (g.memberId === ctx.item.owner_member_id) continue // owners already manage it
    statements.push(
      g.role
        ? storageDb.setGrant(env.DB, { itemId: ctx.item.id, memberId: g.memberId, role: g.role, userId: actor.userId, now })
        : storageDb.removeGrant(env.DB, ctx.item.id, g.memberId),
    )
  }
  if (statements.length) await env.DB.batch(statements)
  return listAccess(env, actor, itemId)
}

// ---------------------------------------------------------------------------------------------------------------
// Public links: anyone with the token can view and download, without signing in

/** 128 random bits, base64url: the whole secret, so it's never guessable or derived from the item. */
function linkToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export type PublicItem = { id: string; kind: 'folder' | 'file'; name: string; contentType: string | null; size: number; updatedAt: string }

const toPublic = (n: ItemView): PublicItem => ({
  id: n.id,
  kind: n.kind,
  name: n.name,
  contentType: n.content_type,
  size: n.size_bytes,
  updatedAt: n.updated_at,
})

/**
 * The linked item, or something inside it when it's a folder. Every way a link can fail (no such token, turned
 * off, the item or a folder above it in the trash, `targetId` outside the linked folder) is the same 404.
 */
async function linkContext(env: StorageEnv, token: string, targetId?: string) {
  const link = await storageDb.findLink(env.DB, token)
  if (!link) throw notFound('link')
  const chain = await storageDb.chain(env.DB, targetId ?? link.item_id, '')
  const at = chain.findIndex((n) => n.id === link.item_id)
  if (at < 0 || inTrash(chain)) throw notFound('link')
  return { link, chain, target: chain[0]!, root: chain[at]!, below: chain.slice(0, at + 1) }
}

/** What a public link shows: the item, the way down to `folderId` inside it, and the folder's contents. */
export async function publicView(env: StorageEnv, token: string, folderId?: string) {
  const ctx = await linkContext(env, token, folderId)
  const organization = await env.DB.prepare('SELECT name FROM organizations WHERE id = ?')
    .bind(ctx.link.organization_id)
    .first<{ name: string }>()
  const items = ctx.target.kind === 'folder'
    ? sortItems((await storageDb.children(env.DB, ctx.target.id, '')).map(toPublic))
    : []
  return {
    organization: organization?.name ?? null,
    root: toPublic(ctx.root),
    item: toPublic(ctx.target),
    path: [...ctx.below].reverse().map((n) => ({ id: n.id, name: n.name })),
    items,
  }
}

/** A file's current bytes through a public link: the linked file, or a file inside the linked folder. */
export async function publicContent(env: StorageEnv, token: string, itemId?: string): Promise<Response> {
  const ctx = await linkContext(env, token, itemId)
  if (ctx.target.kind !== 'file') throw new ApiError('not_a_file', 'Folders have no contents to download')
  const file = await filesDb.find(env.DB, ctx.target.file_id!)
  if (!file) throw notFound('file')
  return serveFile(env, file, ctx.target.name, { version: ctx.target.version })
}

/**
 * What the sidebar shows: size and file count of My Files, the team folders and the mail attachments you can read,
 * and how many items are in your trash. Current versions only; earlier versions aren't counted.
 */
export async function getUsage(env: StorageEnv, actor: Actor, organizationId: string) {
  const member = await memberOf(env, organizationId, actor)
  const mailboxes = await readableMailboxes(env, actor, organizationId)
  const [drive, attachments, trash] = await Promise.all([
    storageDb.usage(env.DB, organizationId, member.id),
    filesDb.countAttachments(env.DB, mailboxes.map((m) => m.id)),
    storageDb.trashCount(env.DB, organizationId, member.id, actor.userId),
  ])
  let attachmentBytes = 0
  let attachmentFiles = 0
  for (const c of attachments.values()) {
    attachmentBytes += c.bytes
    attachmentFiles += c.n
  }
  return {
    personal: { bytes: drive.personal_bytes, files: drive.personal_files },
    organization: { bytes: drive.organization_bytes, files: drive.organization_files },
    attachments: { bytes: attachmentBytes, files: attachmentFiles },
    trash: { items: trash },
  }
}

/** People in the organization, to share with. */
export async function listMembers(env: StorageEnv, actor: Actor, organizationId: string) {
  await memberOf(env, organizationId, actor)
  const rows = await storageDb.organizationMembers(env.DB, organizationId)
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role }))
}

// ---------------------------------------------------------------------------------------------------------------
// Mail Attachments

const ATTACHMENT_PAGE = 100

/**
 * The attachments of every mailbox whose mail the actor can read, newest first: the "Mail Attachments" folder.
 * Personal mailboxes count only for their owner, shared and agent mailboxes for whoever has access (mailAccess).
 */
export async function listAttachments(
  env: StorageEnv,
  actor: Actor,
  organizationId: string,
  input: { mailboxId?: string; source?: 'received' | 'sent'; query?: string; cursor?: string; limit?: number },
) {
  const mailboxes = await readableMailboxes(env, actor, organizationId)
  const ids = input.mailboxId ? mailboxes.filter((m) => m.id === input.mailboxId).map((m) => m.id) : mailboxes.map((m) => m.id)
  if (input.mailboxId && !ids.length) throw notFound('mailbox')
  const limit = Math.min(input.limit ?? ATTACHMENT_PAGE, 200)
  const [createdAt, id] = input.cursor?.split('|') ?? []
  const [rows, counts] = await Promise.all([
    filesDb.listAttachments(env.DB, ids, {
      source: input.source,
      query: input.query?.trim() || undefined,
      before: createdAt && id ? { createdAt, id } : undefined,
      limit: limit + 1,
    }),
    filesDb.countAttachments(env.DB, mailboxes.map((m) => m.id)),
  ])
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    mailboxes: mailboxes.map((m) => ({
      id: m.id,
      address: m.address,
      displayName: m.display_name,
      kind: m.kind,
      count: counts.get(m.id)?.n ?? 0,
      bytes: counts.get(m.id)?.bytes ?? 0,
    })),
    files: page.map(toAttachment),
    nextCursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null,
  }
}

/** Loads a mail attachment and checks the actor can read its mailbox. */
async function attachmentContext(env: StorageEnv, actor: Actor, fileId: string): Promise<FileRow> {
  const file = await filesDb.find(env.DB, fileId)
  if (!file || !file.mailbox_id || file.status !== 'ready' || (file.source !== 'received' && file.source !== 'sent')) {
    throw notFound('file')
  }
  await mailContext(env, actor, file.mailbox_id, 'read').catch(() => {
    throw notFound('file')
  })
  return file
}

export async function getAttachment(env: StorageEnv, actor: Actor, fileId: string) {
  const file = await attachmentContext(env, actor, fileId)
  const mailbox = await mailContext(env, actor, file.mailbox_id!, 'read')
  return { file: toAttachment(file), mailbox: { id: mailbox.mailbox.id, address: mailbox.mailbox.address } }
}

export async function attachmentContent(env: StorageEnv, actor: Actor, fileId: string): Promise<Response> {
  const file = await attachmentContext(env, actor, fileId)
  return serveFile(env, file, file.name)
}

export async function attachmentDownloadUrl(env: StorageEnv, actor: Actor, fileId: string) {
  const file = await attachmentContext(env, actor, fileId)
  const bucket = await organizationBucket(env, file.organization_id)
  const url = await presign(env, bucket, file.r2_key, { method: 'GET', expiresIn: DOWNLOAD_SECONDS, fileName: file.name })
  return { url, expiresAt: new Date(Date.now() + DOWNLOAD_SECONDS * 1000).toISOString() }
}

/** Copies a mail attachment into Storage (My Files unless a folder is given), where it can be edited and shared. */
export async function saveAttachment(
  env: StorageEnv,
  actor: Actor,
  fileId: string,
  where: { parentId?: string | null; space?: Space },
): Promise<StorageItem> {
  const file = await attachmentContext(env, actor, fileId)
  const target = await targetContext(env, actor, file.organization_id, where)
  const name = await freeName(env, target, file.name)
  const bucket = await organizationBucket(env, file.organization_id)
  const itemId = crypto.randomUUID()
  const newFileId = crypto.randomUUID()
  const key = `drive/${itemId}/${newFileId}/${name}`
  if (!(await copyObject(env, bucket, file.r2_key, key))) throw notFound('file')
  const stored = { fileId: newFileId, key, size: file.size_bytes, sha256: file.sha256 ?? '' }
  const contentType = contentTypeFor(name, file.content_type)
  const now = new Date().toISOString()
  try {
    await env.DB.batch([
      filesDb.insert(env.DB, versionRow(file.organization_id, itemId, 1, stored, name, contentType, actor.userId, now)),
      storageDb.insert(env.DB, {
        id: itemId,
        organization_id: file.organization_id,
        space: target.space,
        parent_id: target.parentId,
        kind: 'file',
        name,
        owner_member_id: target.member.id,
        org_access: null,
        file_id: newFileId,
        version: 1,
        size_bytes: file.size_bytes,
        content_type: contentType,
        created_by: actor.userId,
        created_at: now,
        updated_by: actor.userId,
        updated_at: now,
      }),
    ])
  } catch (err) {
    await deleteObject(env, bucket, key).catch(() => null)
    throw isUniqueViolation(err) ? new ApiError('name_taken', `Something called ${name} was just added here. Try again.`, 409) : err
  }
  await enqueueIndex(env, [newFileId])
  return (await getItem(env, actor, itemId)).item
}

// ---------------------------------------------------------------------------------------------------------------
// Content types

const TYPES: Record<string, string> = {
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/**
 * The type to store a file as. The extension wins for the types Storage opens itself (csv, md, pdf…), since
 * browsers and mail clients label them inconsistently (CSV arrives as application/vnd.ms-excel, Markdown as
 * application/octet-stream).
 */
export function contentTypeFor(name: string, given: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const known = TYPES[ext]
  if (known) return known
  const clean = given.split(';')[0]!.trim().toLowerCase()
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(clean) ? clean : 'application/octet-stream'
}

export type { Role }
