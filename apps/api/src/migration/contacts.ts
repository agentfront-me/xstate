// Copying one person's Google contacts into the organization's audience (AudienceStore), as contacts owned by their
// member: first their contacts, then Google's auto-saved "Other contacts" (marked other: true, which keeps them out
// of the Users list and in compose suggestions). One page per queue job, claimed in the MigrationStore first so a
// retry or an overlapping job never adds a contact twice. See the Workspace Migration Plan, phase 3.

import { importContacts } from '../audience/service'
import * as migrationsDb from '../db/migrations'
import type { MigrationUserRow } from '../db/migrations'
import { organizationBucket } from '../storage/buckets'
import { putObject } from '../storage/r2'
import { GoogleError } from './google/auth'
import { contactAttributes } from './contact-rules'
import { workspace } from './google/workspace'
import { finishIfDone } from './final'
import { enqueueMigrationJobs, HELD_RETRY_SECONDS } from './jobs'
import { migrationStore } from './store'

export type ContactsJob = { kind: 'contacts'; migrationId: string; googleId: string; chain: number }

type Cursor = { which: 'connections' | 'other'; token: string | null }
const START: Cursor = { which: 'connections', token: null }
/** Contact photos bigger than this are left out. */
const MAX_PHOTO_BYTES = 2 * 1024 * 1024

export async function copyContactsPage(env: Env, job: ContactsJob): Promise<void> {
  const m = await migrationsDb.find(env.DB, job.migrationId)
  if (!m || m.status === 'cancelled' || m.paused_at || m.access_lost_at) return
  const u = await migrationsDb.findUser(env.DB, job.migrationId, job.googleId)
  if (!u || u.contacts_chain !== job.chain || !u.copy_contacts || u.contacts_state === 'done' || u.contacts_state === 'attention') return
  // Contacts belong to a member. Someone copied into a shared mailbox (or a mailbox nobody owns) has none.
  if (!u.member_id) return finish(env, u, 'No member to own these contacts')

  try {
    await copyPage(env, job, m.organization_id, u, u.member_id)
  } catch (err) {
    if (err instanceof GoogleError && err.code === 'not_authorized') {
      await migrationsDb.update(env.DB, job.migrationId, { access_lost_at: new Date().toISOString() }).run()
      return
    }
    if (err instanceof GoogleError && err.code === 'no_such_user') {
      return setNote(env, u, 'attention', 'Google won’t let xstate read this account’s contacts (suspended or deleted).')
    }
    throw err
  }
}

async function copyPage(env: Env, job: ContactsJob, organizationId: string, u: MigrationUserRow, ownerMemberId: string) {
  const ws = workspace(env)
  const store = migrationStore(env, organizationId)
  const cursor: Cursor = u.contacts_cursor ? (JSON.parse(u.contacts_cursor) as Cursor) : START

  const [groups, page] = await Promise.all([ws.contactGroups(u.email), ws.contactsPage(u.email, cursor.which, cursor.token)])
  // The total grows as each list is reached: their contacts first, then Other contacts.
  let total = u.contacts_total ?? 0
  if (!cursor.token) total = cursor.which === 'connections' ? page.total : total + page.total
  if (!u.contacts_state) {
    await env.DB.prepare("UPDATE migration_users SET contacts_state = 'copying' WHERE migration_id = ? AND google_id = ?").bind(u.migration_id, u.google_id).run()
  }

  const claim = `${job.migrationId}:${u.google_id}:${job.chain}:${cursor.which}:${cursor.token ?? 'first'}`
  const claimed = await store.claim('contact', u.google_id, page.contacts.map((c) => c.id), claim)
  const mine = new Set(claimed.mine)
  const todo = page.contacts.filter((c) => mine.has(c.id))
  const empty = todo.filter((c) => !c.emails.length && !c.phones.length && !c.name)
  const keep = todo.filter((c) => !empty.includes(c))

  // Photos go to the organization's bucket, next to the member's other files; the contact keeps the key.
  const bucket = keep.some((c) => c.photoUrl) ? await organizationBucket(env, organizationId).catch(() => null) : null
  const rows = []
  for (const c of keep) {
    const attributes = contactAttributes(c, groups, cursor.which === 'other')
    if (c.photoUrl && bucket) {
      const photo = await ws.fetchPhoto(c.photoUrl).catch(() => null)
      if (photo && photo.bytes.byteLength <= MAX_PHOTO_BYTES) {
        const key = `contacts/${ownerMemberId}/${await shortHash(c.id)}`
        await putObject(env, bucket, key, photo.bytes, { contentType: photo.type })
        attributes.photoKey = key
      }
    }
    rows.push({ name: c.name, email: c.emails[0] ?? null, phone: c.phones[0] ?? null, attributes })
  }
  const ids = rows.length ? await importContacts(env, organizationId, ownerMemberId, rows) : []
  if (ids.length) await store.record('contact', u.google_id, keep.map((c, i) => ({ sourceId: c.id, targetId: ids[i]! })))
  if (empty.length) await store.skip('contact', u.google_id, empty.map((c) => ({ sourceId: c.id, reason: 'empty' })))

  // Contacts held by another job's claim: come back to this page later instead of moving past them.
  const next: Cursor | null = claimed.held
    ? cursor
    : page.nextPageToken
    ? { which: cursor.which, token: page.nextPageToken }
    : cursor.which === 'connections'
      ? { which: 'other', token: null }
      : null
  const counts = await store.counts('contact', u.google_id)
  await env.DB.prepare(
    `UPDATE migration_users SET contacts_done = ?, contacts_total = MAX(?, ?), contacts_cursor = ?, contacts_note = NULL
     WHERE migration_id = ? AND google_id = ?`,
  )
    .bind(counts.copied + counts.skipped, total, counts.copied + counts.skipped, next ? JSON.stringify(next) : null, u.migration_id, u.google_id)
    .run()
  if (next) {
    await enqueueMigrationJobs(env, [{ kind: 'contacts', migrationId: job.migrationId, googleId: u.google_id, chain: job.chain }], claimed.held ? HELD_RETRY_SECONDS : undefined)
  }
  else await finish(env, u, null)
}

/** Done: the total becomes what was actually handled (Google's totals are estimates). */
async function finish(env: Env, u: MigrationUserRow, note: string | null) {
  await setNote(env, u, 'done', note)
  await env.DB.prepare('UPDATE migration_users SET contacts_total = contacts_done WHERE migration_id = ? AND google_id = ?').bind(u.migration_id, u.google_id).run()
  // The final pass reads contacts again through this same chain.
  if (u.final_contacts_base !== null) await finishIfDone(env, u.migration_id)
}

async function setNote(env: Env, u: MigrationUserRow, state: 'done' | 'attention', note: string | null) {
  await env.DB.prepare('UPDATE migration_users SET contacts_state = ?, contacts_note = ? WHERE migration_id = ? AND google_id = ?')
    .bind(state, note, u.migration_id, u.google_id)
    .run()
}

async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
