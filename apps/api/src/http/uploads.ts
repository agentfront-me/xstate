// POST /v1/email/mailboxes/:mailboxId/uploads?name=<file name>: the request body is the file. It is kept in the
// organization's bucket (mailbox/outbound.ts) and deleted after a day if it isn't sent; the returned blob id goes in
// email_send's attachments. Going through the API (not straight to R2) also works for the desktop app, whose app://
// origin R2's CORS rules can't allow.

import type { Context } from 'hono'
import { uploadAttachment } from '../mailserver'
import type { AppEnv } from './types'

export async function handleAttachmentUpload(c: Context<AppEnv>): Promise<Response> {
  const body = c.req.raw.body
  if (!body) return c.json({ error: { code: 'invalid_upload', message: 'Send the file as the request body' } }, 400)
  const name = (c.req.query('name') ?? 'attachment').slice(0, 255) || 'attachment'
  const contentType = c.req.header('Content-Type') || 'application/octet-stream'
  const size = Number(c.req.header('Content-Length') ?? NaN)
  const blob = await uploadAttachment(c.env, c.get('actor'), c.req.param('mailboxId') ?? '', body, { name, contentType, size })
  // `safety`: a warning (macros, a password-protected archive…) for the composer to show. Blocked files fail above.
  return c.json({ attachment: { blobId: blob.blobId, name, type: contentType, size: blob.size, safety: blob.safety } }, 201)
}
