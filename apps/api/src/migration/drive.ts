// Copying Google Drive into Storage: each person's My Drive (the files they own) into their My Files, and each
// ticked shared drive into a team folder in the organization space. See the Workspace Migration Plan, phase 4.
//
// A source (a person or a shared drive) is copied by a chain of queue jobs: first its folders (all listed, then
// created parents first), then its files, a page per job. Each file is streamed from Google into R2 (multipart past
// 100 MB) and checked against Google's MD5. Google Docs, Sheets, Slides and Drawings are exported to Office formats
// and PDF; Forms, Sites, shortcuts and the like are skipped and reported. Sharing is recreated as it's copied:
// people and groups in the organization become grants, domain-wide sharing becomes organization access, and links
// for anyone and outsiders go in the report. Everything is claimed in the MigrationStore first, so nothing is copied
// twice.

import * as migrationsDb from '../db/migrations'
import type { MigrationRow } from '../db/migrations'
import { ApiError } from '../errors'
import { importAccess, importFile, importFolder, importVersion, type ImportTarget } from '../storage/drive'
import { sharingFor, skipReason, type SharingContext } from './drive-rules'
import { GoogleError } from './google/auth'
import { FOLDER_MIME, GOOGLE_EXPORTS, workspace, type GDriveFile } from './google/workspace'
import { enqueueMigrationJobs, HELD_RETRY_SECONDS } from './jobs'
import { migrationStore } from './store'

/** `owner` is the Google user id for a My Drive, or the shared drive's id. */
export type DriveJob = { kind: 'drive'; migrationId: string; owner: string; shared: boolean; chain: number }

type Cursor = { phase: 'folders' | 'files'; token: string | null }
const START: Cursor = { phase: 'folders', token: null }
/** Files copied per job: each can be large, so few. */
const FILE_PAGE = 20
/** Folders created per job; a source with more continues in the next job. */
const FOLDERS_PER_JOB = 300
/** Most folder pages listed at once (1,000 a page). */
const MAX_FOLDER_PAGES = 20

/** One source being copied: where it's read from, where it goes, and how its progress is saved. */
type Source = {
  owner: string
  actAs: string
  driveId?: string
  root: ImportTarget
  cursor: Cursor
  chain: number
  save(p: { done: number; bytes: number; cursor: Cursor | null; state: 'copying' | 'done' }): Promise<void>
  attention(note: string): Promise<void>
}

export async function copyDrivePage(env: Env, job: DriveJob): Promise<void> {
  const m = await migrationsDb.find(env.DB, job.migrationId)
  if (!m || m.status === 'cancelled' || m.paused_at || m.access_lost_at) return
  let source: Source | null = null
  try {
    source = job.shared ? await sharedSource(env, m, job) : await userSource(env, m, job)
    if (!source) return
    if (source.cursor.phase === 'folders') await copyFolders(env, m, source)
    else await copyFiles(env, m, source)
  } catch (err) {
    if (err instanceof GoogleError && err.code === 'not_authorized') {
      await migrationsDb.update(env.DB, m.id, { access_lost_at: new Date().toISOString() }).run()
      return
    }
    if (err instanceof GoogleError && err.code === 'no_such_user') {
      const note = 'Google won’t let xstate read this Drive (the account is suspended or deleted).'
      if (source) return source.attention(note)
      await env.DB.prepare("UPDATE migration_users SET drive_state = 'attention', drive_note = ? WHERE migration_id = ? AND google_id = ?").bind(note, m.id, job.owner).run()
      return
    }
    throw err
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sources

async function memberUserId(env: Env, memberId: string): Promise<string> {
  return (await env.DB.prepare('SELECT user_id FROM members WHERE id = ?').bind(memberId).first<{ user_id: string }>())!.user_id
}

/** The member of the admin who started the migration: owner of team folders made by the import. */
async function starterMember(env: Env, m: MigrationRow): Promise<{ memberId: string; userId: string }> {
  const row = await env.DB.prepare("SELECT id FROM members WHERE organization_id = ? AND user_id = ? AND status = 'active'")
    .bind(m.organization_id, m.started_by)
    .first<{ id: string }>()
  if (!row || !m.started_by) throw new ApiError('no_actor', 'The admin who started this migration is no longer in the organization', 409)
  return { memberId: row.id, userId: m.started_by }
}

/** `final`: for the final pass, which runs after the copy is done (so state and chain don't matter). */
async function userSource(env: Env, m: MigrationRow, job: DriveJob, final = false): Promise<Source | null> {
  const u = await migrationsDb.findUser(env.DB, m.id, job.owner)
  if (!u || !u.copy_drive || u.action === 'skip') return null
  if (!final && (u.drive_chain !== job.chain || u.drive_state === 'done' || u.drive_state === 'attention')) return null

  let root: ImportTarget
  if (u.member_id) {
    root = { organizationId: m.organization_id, space: 'personal', parentId: null, ownerMemberId: u.member_id, userId: await memberUserId(env, u.member_id) }
  } else {
    // Nobody to own a My Files (someone imported as a shared mailbox): their Drive goes in a team folder that only
    // admins see until it's shared.
    const starter = await starterMember(env, m)
    let folder = u.drive_root
    if (!folder) {
      // Make sure Google lets us read this Drive before making a folder for it (suspended accounts can't be read).
      await workspace(env).driveList(u.email, { folders: true, pageToken: null, pageSize: 1 })
      folder = await importFolder(env, { organizationId: m.organization_id, space: 'organization', parentId: null, ownerMemberId: starter.memberId, userId: starter.userId }, `${u.name}’s Drive`)
      await env.DB.prepare('UPDATE migration_users SET drive_root = ? WHERE migration_id = ? AND google_id = ?').bind(folder, m.id, u.google_id).run()
    }
    root = { organizationId: m.organization_id, space: 'organization', parentId: folder, ownerMemberId: starter.memberId, userId: starter.userId }
  }

  const where = 'WHERE migration_id = ? AND google_id = ?'
  return {
    owner: u.google_id,
    actAs: u.email,
    root,
    cursor: u.drive_cursor ? (JSON.parse(u.drive_cursor) as Cursor) : START,
    chain: job.chain,
    save: async (p) => {
      await env.DB.prepare(`UPDATE migration_users SET drive_done = ?, drive_copied_bytes = ?, drive_cursor = ?, drive_state = ?, drive_note = NULL ${where}`)
        .bind(p.done, p.bytes, p.cursor ? JSON.stringify(p.cursor) : null, p.state, m.id, u.google_id)
        .run()
    },
    attention: async (note) => {
      await env.DB.prepare(`UPDATE migration_users SET drive_state = 'attention', drive_note = ? ${where}`).bind(note, m.id, u.google_id).run()
    },
  }
}

async function sharedSource(env: Env, m: MigrationRow, job: DriveJob, final = false): Promise<Source | null> {
  const d = await env.DB.prepare('SELECT * FROM migration_drives WHERE migration_id = ? AND drive_id = ?')
    .bind(m.id, job.owner)
    .first<migrationsDb.MigrationDriveRow>()
  if (!d) return null
  if (!final && (d.chain !== job.chain || d.state === 'done' || d.state === 'attention')) return null
  const where = 'WHERE migration_id = ? AND drive_id = ?'
  const attention = async (note: string) => {
    await env.DB.prepare(`UPDATE migration_drives SET state = 'attention', note = ? ${where}`).bind(note, m.id, d.drive_id).run()
  }
  const ws = workspace(env)
  const organizer = await ws.sharedDriveOrganizer(m.admin_email!, d.drive_id)
  if (!organizer) {
    await attention('This shared drive has no organizer xstate can act as. Add one in Google, then try again.')
    return null
  }

  const starter = await starterMember(env, m)
  let folder = d.folder_id
  if (!folder) {
    // The team folder gets the shared drive's members: organizers manage it, writers edit, readers view.
    folder = await importFolder(env, { organizationId: m.organization_id, space: 'organization', parentId: null, ownerMemberId: starter.memberId, userId: starter.userId }, d.name)
    const sharing = sharingFor(await ws.sharedDrivePermissions(m.admin_email!, d.drive_id), { ...(await sharingContext(env, m)), ownerMemberId: starter.memberId })
    await importAccess(env, folder, starter.userId, { grants: sharing.grants, orgAccess: sharing.orgAccess })
    await env.DB.prepare(`UPDATE migration_drives SET folder_id = ?, state = 'copying' ${where}`).bind(folder, m.id, d.drive_id).run()
  }

  return {
    owner: d.drive_id,
    actAs: organizer,
    driveId: d.drive_id,
    root: { organizationId: m.organization_id, space: 'organization', parentId: folder, ownerMemberId: starter.memberId, userId: starter.userId },
    cursor: d.cursor ? (JSON.parse(d.cursor) as Cursor) : START,
    chain: job.chain,
    save: async (p) => {
      await env.DB.prepare(`UPDATE migration_drives SET done = ?, bytes = ?, cursor = ?, state = ?, note = NULL ${where}`)
        .bind(p.done, p.bytes, p.cursor ? JSON.stringify(p.cursor) : null, p.state, m.id, d.drive_id)
        .run()
    },
    attention,
  }
}

/** Who sharing can point at: members by email, the Workspace's groups and domains. */
async function sharingContext(env: Env, m: MigrationRow): Promise<Omit<SharingContext, 'ownerMemberId'>> {
  const { results } = await env.DB.prepare('SELECT u.email, m.id FROM members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ?')
    .bind(m.organization_id)
    .all<{ email: string; id: string }>()
  const groups = JSON.parse(m.groups ?? '[]') as { email: string; memberEmails: string[] }[]
  const domains = (JSON.parse(m.domains ?? '[]') as { name: string }[]).map((d) => d.name)
  return {
    memberByEmail: new Map(results.map((r) => [r.email.toLowerCase(), r.id])),
    groupMembers: new Map(groups.map((g) => [g.email, g.memberEmails])),
    domains: new Set([...domains, ...(m.google_domain ? [m.google_domain] : [])]),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Folders: listed whole, then created parents first

async function copyFolders(env: Env, m: MigrationRow, s: Source) {
  const ws = workspace(env)
  const store = migrationStore(env, m.organization_id)
  // Where Drive's change feed stands before anything is copied, so the final pass sees every change after it.
  if (!s.cursor.token) {
    const sql = s.driveId
      ? 'UPDATE migration_drives SET changes_token = ? WHERE migration_id = ? AND drive_id = ? AND changes_token IS NULL'
      : 'UPDATE migration_users SET drive_changes_token = ? WHERE migration_id = ? AND google_id = ? AND drive_changes_token IS NULL'
    await env.DB.prepare(sql).bind(await ws.driveStartToken(s.actAs, s.driveId), m.id, s.owner).run()
  }
  const folders: GDriveFile[] = []
  let token: string | null = null
  for (let i = 0; i < MAX_FOLDER_PAGES; i++) {
    const page = await ws.driveList(s.actAs, { folders: true, driveId: s.driveId, pageToken: token, pageSize: 1000 })
    folders.push(...page.files)
    token = page.nextPageToken
    if (!token) break
  }

  const made = new Map(Object.entries(await store.map('folder', s.owner)))
  const ours = new Set(folders.map((f) => f.id))
  const ctx = await sharingContext(env, m)
  let created = 0
  // Each pass creates the folders whose parent exists (or isn't one of ours: those go at the top).
  for (let progress = true; progress && created < FOLDERS_PER_JOB; ) {
    progress = false
    for (const f of folders) {
      if (made.has(f.id) || created >= FOLDERS_PER_JOB) continue
      const parent = f.parents[0]
      if (parent && ours.has(parent) && !made.has(parent)) continue
      const parentId = (parent && made.get(parent)) || s.root.parentId
      const id = await importFolder(env, { ...s.root, parentId }, f.name)
      const sharing = sharingFor(f.permissions, { ...ctx, ownerMemberId: s.root.ownerMemberId })
      await importAccess(env, id, s.root.userId, { grants: sharing.grants, ...(sharing.orgAccess && { orgAccess: sharing.orgAccess }) })
      if (sharing.notRecreated.length) await store.skip('sharing', s.owner, [{ sourceId: f.id, reason: 'sharing_not_recreated', detail: `${f.name}: ${sharing.notRecreated.join(', ')}` }])
      await store.record('folder', s.owner, [{ sourceId: f.id, targetId: id }])
      made.set(f.id, id)
      created++
      progress = true
    }
  }

  const remaining = folders.some((f) => !made.has(f.id))
  const counts = await store.counts('file', s.owner)
  const progress = await currentBytes(env, m, s)
  await s.save({ done: counts.copied + counts.skipped, bytes: progress, cursor: remaining ? s.cursor : { phase: 'files', token: null }, state: 'copying' })
  await next(env, m, s)
}

// ---------------------------------------------------------------------------------------------------------------
// Files

async function copyFiles(env: Env, m: MigrationRow, s: Source) {
  const ws = workspace(env)
  const store = migrationStore(env, m.organization_id)
  const page = await ws.driveList(s.actAs, { folders: false, driveId: s.driveId, pageToken: s.cursor.token, pageSize: FILE_PAGE })
  const claim = `${m.id}:${s.owner}:${s.chain}:${s.cursor.token ?? 'first'}`
  const claimed = await store.claim('file', s.owner, page.files.map((f) => f.id), claim)
  const mine = new Set(claimed.mine)
  const folders = new Map(Object.entries(await store.map('folder', s.owner)))
  const ctx = await sharingContext(env, m)
  let bytes = await currentBytes(env, m, s)

  for (const f of page.files.filter((x) => mine.has(x.id))) bytes += await copyOne(env, s, f, { store, folders, ctx, claim })

  const counts = await store.counts('file', s.owner)
  // Files held by another job's claim: come back to this page later instead of moving past them.
  const cursor: Cursor | null = claimed.held ? s.cursor : page.nextPageToken ? { phase: 'files', token: page.nextPageToken } : null
  await s.save({ done: counts.copied + counts.skipped, bytes, cursor, state: cursor ? 'copying' : 'done' })
  if (cursor) await next(env, m, s, claimed.held ? HELD_RETRY_SECONDS : undefined)
}

type CopyContext = {
  store: ReturnType<typeof migrationStore>
  folders: Map<string, string>
  ctx: Omit<SharingContext, 'ownerMemberId'>
  claim: string
}

/**
 * Copies one claimed file into Storage with its sharing, and records it (or why it was skipped). Problems with the
 * file itself go in the report; losing access or being rate limited is thrown, with the claim let go. Returns the
 * bytes stored.
 */
async function copyOne(env: Env, s: Source, f: GDriveFile, c: CopyContext): Promise<number> {
  const ws = workspace(env)
  const skip = skipReason(f.mimeType, !!GOOGLE_EXPORTS[f.mimeType])
  if (skip) {
    await c.store.skip('file', s.owner, [{ sourceId: f.id, reason: skip, detail: f.name }])
    return 0
  }
  const parentId = (f.parents[0] && c.folders.get(f.parents[0])) || s.root.parentId
  let itemId: string
  let size: number
  try {
    const download = await ws.driveDownload(s.actAs, f, s.driveId)
    const stored = await importFile(env, { ...s.root, parentId }, { name: download.name, contentType: download.contentType, size: download.size, body: download.body, md5: download.md5 })
    itemId = stored.itemId
    size = stored.size
  } catch (err) {
    const reason = fileProblem(err)
    if (!reason) {
      await c.store.release('file', s.owner, [f.id], c.claim)
      throw err
    }
    await c.store.skip('file', s.owner, [{ sourceId: f.id, reason, detail: `${f.name}: ${err instanceof Error ? err.message : ''}`.slice(0, 300) }])
    return 0
  }
  const sharing = sharingFor(f.permissions, { ...c.ctx, ownerMemberId: s.root.ownerMemberId })
  await importAccess(env, itemId, s.root.userId, { grants: sharing.grants, ...(sharing.orgAccess && { orgAccess: sharing.orgAccess }) })
  if (sharing.notRecreated.length) await c.store.skip('sharing', s.owner, [{ sourceId: f.id, reason: 'sharing_not_recreated', detail: `${f.name}: ${sharing.notRecreated.join(', ')}` }])
  await c.store.record('file', s.owner, [{ sourceId: f.id, targetId: itemId }])
  return size
}

/** A problem with one file that goes in the report rather than stopping the copy, or null. */
function fileProblem(err: unknown): string | null {
  if (err instanceof ApiError && err.code === 'checksum_mismatch') return 'checksum_mismatch'
  if (err instanceof GoogleError && err.code === 'forbidden') return 'export_failed'
  if (err instanceof GoogleError && err.code === 'not_found') return 'gone'
  return null
}

async function next(env: Env, m: MigrationRow, s: Source, delaySeconds?: number) {
  await enqueueMigrationJobs(env, [{ kind: 'drive', migrationId: m.id, owner: s.owner, shared: !!s.driveId, chain: s.chain }], delaySeconds)
}

async function currentBytes(env: Env, m: MigrationRow, s: Source): Promise<number> {
  const row = s.driveId
    ? await env.DB.prepare('SELECT bytes AS b FROM migration_drives WHERE migration_id = ? AND drive_id = ?').bind(m.id, s.owner).first<{ b: number }>()
    : await env.DB.prepare('SELECT drive_copied_bytes AS b FROM migration_users WHERE migration_id = ? AND google_id = ?').bind(m.id, s.owner).first<{ b: number }>()
  return row?.b ?? 0
}

// ---------------------------------------------------------------------------------------------------------------
// The final pass: Drive's change feed since the copy began. New files and folders are copied; files edited in
// Google get a new version in xstate. Files removed or trashed in Google stay in xstate.

export type DriveFinalJob = { kind: 'final_drive'; migrationId: string; owner: string; shared: boolean; run: number }

export async function driveFinalPage(env: Env, job: DriveFinalJob): Promise<void> {
  const m = await migrationsDb.find(env.DB, job.migrationId)
  if (!m || m.status === 'cancelled' || m.paused_at || m.access_lost_at) return
  const where = job.shared ? 'WHERE migration_id = ? AND drive_id = ?' : 'WHERE migration_id = ? AND google_id = ?'
  const table = job.shared ? 'migration_drives' : 'migration_users'
  const [tokenCol, stateCol, changesCol] = job.shared ? ['changes_token', 'final_state', 'final_changes'] : ['drive_changes_token', 'final_drive', 'final_drive_changes']
  const done = () => env.DB.prepare(`UPDATE ${table} SET ${stateCol} = 'done' ${where}`).bind(m.id, job.owner).run()

  const asCopy: DriveJob = { kind: 'drive', migrationId: m.id, owner: job.owner, shared: job.shared, chain: 0 }
  let s: Source | null
  try {
    s = job.shared ? await sharedSource(env, m, asCopy, true) : await userSource(env, m, asCopy, true)
  } catch (err) {
    if (err instanceof GoogleError && err.code === 'no_such_user') return void (await done())
    throw err
  }
  if (!s) return void (await done())
  const row = await env.DB.prepare(`SELECT ${tokenCol} AS token FROM ${table} ${where}`).bind(m.id, job.owner).first<{ token: string | null }>()

  // No change feed position (copied before it was recorded): list the files again; anything new is copied.
  if (!row?.token) {
    const chainCol = job.shared ? 'chain' : 'drive_chain'
    const stCol = job.shared ? 'state' : 'drive_state'
    const curCol = job.shared ? 'cursor' : 'drive_cursor'
    await env.DB.prepare(`UPDATE ${table} SET ${stCol} = 'copying', ${curCol} = ?, ${chainCol} = ${chainCol} + 1 ${where}`)
      .bind(JSON.stringify({ phase: 'files', token: null }), m.id, job.owner)
      .run()
    const chain = (await env.DB.prepare(`SELECT ${chainCol} AS c FROM ${table} ${where}`).bind(m.id, job.owner).first<{ c: number }>())!.c
    await enqueueMigrationJobs(env, [{ ...asCopy, chain }])
    return void (await done())
  }

  const ws = workspace(env)
  const store = migrationStore(env, m.organization_id)
  const page = await ws.driveChanges(s.actAs, row.token, s.driveId)
  const folders = new Map(Object.entries(await store.map('folder', s.owner)))
  const ctx = await sharingContext(env, m)
  const claim = `final:${job.run}:${s.owner}:${row.token}`
  let changes = 0
  for (const ch of page.changes) {
    const f = ch.file
    if (ch.removed || !f) continue
    if (f.mimeType === FOLDER_MIME) {
      if (folders.has(f.id)) continue
      const parentId = (f.parents[0] && folders.get(f.parents[0])) || s.root.parentId
      const id = await importFolder(env, { ...s.root, parentId }, f.name)
      await store.record('folder', s.owner, [{ sourceId: f.id, targetId: id }])
      folders.set(f.id, id)
      changes++
      continue
    }
    const target = (await store.targets('file', s.owner, [f.id]))[f.id]
    if (target) {
      // Edited in Google after the copy: a new version.
      try {
        const download = await ws.driveDownload(s.actAs, f, s.driveId)
        if ((await importVersion(env, target, s.root.userId, { contentType: download.contentType, size: download.size, body: download.body, md5: download.md5 })) !== null) changes++
      } catch (err) {
        const reason = fileProblem(err)
        if (!reason) throw err
        await store.skip('file_update', s.owner, [{ sourceId: f.id, reason, detail: f.name }])
      }
      continue
    }
    const { mine } = await store.claim('file', s.owner, [f.id], claim)
    if (mine.length) {
      await copyOne(env, s, f, { store, folders, ctx, claim })
      changes++
    }
  }

  const nextToken = page.nextPageToken ?? page.newStartPageToken ?? row.token
  // Files added by the pass count towards the person's (or drive's) total in the report.
  const counts = await store.counts('file', s.owner)
  const doneCol = job.shared ? 'done' : 'drive_done'
  await env.DB.prepare(`UPDATE ${table} SET ${tokenCol} = ?, ${changesCol} = ${changesCol} + ?, ${doneCol} = ? ${where}`)
    .bind(nextToken, changes, counts.copied + counts.skipped, m.id, job.owner)
    .run()
  if (page.nextPageToken) await enqueueMigrationJobs(env, [job])
  else await done()
}
