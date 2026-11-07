// An admin keeping a file out of search. The flag lives on the files row, so it covers Storage versions and mail
// attachments alike; a new version copies it (filesDb.copySearchExcluded), so it sticks across edits.

import * as filesDb from '../db/files'
import * as membersDb from '../db/members'
import * as searchDb from '../db/search'
import { ApiError } from '../errors'
import type { Actor } from '../auth/types'
import { isAdmin } from '../mailserver/access'
import { removeDocument, type IndexEnv } from './indexer'
import { enqueueIndex } from './jobs'

export type ExcludeEnv = IndexEnv & Pick<Env, 'SEARCH_INDEX'>

/** Turns search on or off for a file. Owners and admins of its organization only; others get a 404. */
export async function setSearchExcluded(env: ExcludeEnv, actor: Actor, fileId: string, excluded: boolean) {
  const file = await filesDb.find(env.DB, fileId)
  const member = file && (await membersDb.find(env.DB, file.organization_id, actor.userId))
  if (!file || !member || file.status !== 'ready') throw new ApiError('not_found', 'No such file', 404)
  if (!isAdmin(member)) throw new ApiError('forbidden', 'Only owners and admins can change what search sees', 403)

  await filesDb.setSearchExcluded(env.DB, file.id, excluded).run()
  const doc = searchDb.fileDoc(file.id)
  if (excluded) {
    // The vectors go now, not on the next job: once an admin says "not searchable", nothing should find it.
    const row = await searchDb.find(env.DB, doc)
    if (row && row.chunks) await removeDocument(env, row)
    await searchDb
      .upsert(env.DB, {
        doc_id: doc,
        file_id: file.id,
        item_id: file.item_id,
        mailbox_id: file.mailbox_id,
        organization_id: file.organization_id,
        chunks: 0,
        status: 'excluded',
        error: null,
        indexed_at: new Date().toISOString(),
        folder: null,
      })
      .run()
  } else {
    await enqueueIndex(env, [file.id])
  }
  return { fileId: file.id, searchExcluded: excluded }
}
