// Storage routes whose request body is the file itself, not JSON (the operations in operations/storage.ts cover
// the rest):
//   POST /v1/storage/orgs/:organizationId/files?name=&parentId=&space=   a new file
//   PUT  /v1/storage/items/:itemId/content?baseVersion=<n>              new contents for a file (the next version)
// Both stream to R2 through the Worker, which works from the desktop app too (its app:// origin can't pass R2's
// CORS rules). Content-Length is required: R2 needs it for streamed writes.

import type { Context } from 'hono'
import { z } from 'zod'
import * as drive from '../storage/drive'
import type { AppEnv } from './types'

const space = z.enum(['personal', 'organization']).optional()

function body(c: Context<AppEnv>) {
  const stream = c.req.raw.body
  return {
    body: stream ?? new Uint8Array(),
    size: stream ? Number(c.req.header('Content-Length') ?? NaN) : 0,
    contentType: c.req.header('Content-Type') || 'application/octet-stream',
  }
}

export async function handleStorageUpload(c: Context<AppEnv>): Promise<Response> {
  const query = z
    .object({ name: z.string().min(1).max(255), parentId: z.string().min(1).max(64).optional(), space })
    .parse(c.req.query())
  const item = await drive.uploadFile(c.env, c.get('actor'), c.req.param('organizationId') ?? '', query, {
    name: query.name,
    ...body(c),
  })
  return c.json({ item }, 201)
}

export async function handleStorageSave(c: Context<AppEnv>): Promise<Response> {
  const { baseVersion } = z.object({ baseVersion: z.coerce.number().int().min(1) }).parse(c.req.query())
  const item = await drive.writeContent(c.env, c.get('actor'), c.req.param('itemId') ?? '', baseVersion, body(c))
  return c.json({ item })
}
