// /v1/emails: sending email from a server with a personal API token, and reading the send log
// (emails/service.ts, docs/transactional-api-plan.md). These routes sit behind requireToken, not the session
// sign-in the rest of /v1 uses, and are not operations: they are never MCP tools and never take a session.
//
//   POST /v1/emails        send a message; optional Idempotency-Key header
//   GET  /v1/emails/:id    one message and the delivery status of each recipient
//   GET  /v1/emails        the send log, newest first: ?limit, cursor, status, from, tag.<name>=<value>

import type { Context } from 'hono'
import { z } from 'zod'
import { ApiError } from '../errors'
import { sendInput } from '../emails/rules.ts'
import { getEmail, listEmails, sendEmail } from '../emails/service'
import { readJsonObject } from './router'
import type { AppEnv } from './types'

const auth = (c: Context<AppEnv>) => ({ actor: c.get('actor'), token: c.get('token') })

export async function handleSendEmail(c: Context<AppEnv>): Promise<Response> {
  const input = sendInput.parse(await readJsonObject(c.req.raw))
  const key = c.req.header('Idempotency-Key')?.trim() || null
  if (key && key.length > 255) throw new ApiError('invalid_input', 'An Idempotency-Key can be at most 255 characters')
  const { email, replayed } = await sendEmail(c.env, auth(c), input, key)
  // The first answer again, for a retry of a request that already went through.
  if (replayed) c.header('Idempotent-Replay', 'true')
  return c.json(email, replayed ? 200 : 201)
}

export async function handleGetEmail(c: Context<AppEnv>): Promise<Response> {
  const { email } = await getEmail(c.env, auth(c), c.req.param('id') ?? '')
  return c.json(email)
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(200).optional(),
  status: z.enum(['queued', 'sent', 'delivered', 'bounced', 'complained', 'suppressed']).optional(),
  from: z
    .email()
    .max(254)
    .transform((a) => a.toLowerCase())
    .optional(),
})

export async function handleListEmails(c: Context<AppEnv>): Promise<Response> {
  const query = c.req.query()
  const tags: Record<string, string> = {}
  for (const [name, value] of Object.entries(query)) {
    if (!name.startsWith('tag.')) continue
    const tag = name.slice(4)
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(tag)) throw new ApiError('invalid_input', `"${tag}" is not a tag name`)
    tags[tag] = value
  }
  return c.json(await listEmails(c.env, auth(c), { ...listQuery.parse(query), tags }))
}
