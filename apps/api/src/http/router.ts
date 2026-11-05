// Turns operations into Hono routes, and API errors into JSON responses.

import type { ErrorHandler, Handler, Hono } from 'hono'
import { z } from 'zod'
import { requireAuth } from '../auth/middleware'
import { ApiError } from '../errors'
import type { AnyOperation } from '../operations/define'
import type { AppEnv } from './types'

export function mountOperations(app: Hono<AppEnv>, operations: readonly AnyOperation[]): void {
  for (const operation of operations) {
    if (!operation.http) continue
    const { method, path, status = 200 } = operation.http

    const handler: Handler<AppEnv> = async (c) => {
      const body = method === 'GET' || method === 'DELETE' ? {} : await readJsonObject(c.req.raw)
      // Path params win, so a body can't point the operation at a different organization or object.
      const input = operation.input.parse({ ...body, ...c.req.query(), ...c.req.param() })
      const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise)
      const result = await operation.run({ env: c.env, actor: c.get('actor'), waitUntil }, input)
      if (result === undefined) return c.body(null, 204)
      // Downloads (attachments) return a Response as is.
      if (result instanceof Response) return result
      return c.json(result, status)
    }

    if (operation.public) app.on(method, path, handler)
    else app.on(method, path, requireAuth, handler)
  }
}

export const onError: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
  if (err instanceof z.ZodError) {
    return c.json({ error: { code: 'invalid_input', message: z.prettifyError(err), issues: err.issues } }, 400)
  }
  console.error(err)
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong' } }, 500)
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (!text) return {}
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // Fall through to the error below.
  }
  throw new ApiError('invalid_json', 'The request body must be a JSON object')
}
