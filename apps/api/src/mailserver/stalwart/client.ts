// Stalwart JMAP client. Stalwart's management API is JMAP at /jmap/; see docs/stalwart-api.md.

import { EmailError } from '../errors'
import { fetchWithin, MailServerTimeout, type Limit } from './timeout'

export type StalwartEnv = Pick<Env, 'STALWART_URL' | 'STALWART_API_KEY'>
export type StalwartType = 'x:Domain' | 'x:Account' | 'x:DkimSignature'
type JmapArgs = Record<string, unknown>
type SetError = { type?: string; description?: string; properties?: string[] }

/** Capabilities for the management API (x:Domain, x:Account). Mail calls pass MAIL_CAPABILITIES instead. */
export const MANAGEMENT_CAPABILITIES = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']
export const MAIL_CAPABILITIES = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission']

/**
 * A JMAP request's time limit, response included. Imports and bulk moves send the largest requests (hundreds of
 * objects per call) and still finish in a few seconds when the server is healthy.
 */
const JMAP_TIMEOUT_MS = 30_000

/**
 * fetch() to the mail server under a time limit (./timeout). A call that runs out becomes a 503 the apps can show
 * ("the mail server isn't answering"), instead of a request that hangs until Cloudflare gives up on it.
 */
export async function stalwartFetch<T = Response>(
  input: string | URL,
  init: RequestInit,
  limit: Limit,
  read?: (res: Response) => Promise<T>,
): Promise<T> {
  try {
    return await fetchWithin(input, init, limit, read)
  } catch (err) {
    if (err instanceof MailServerTimeout) {
      throw new EmailError('mail_server_timeout', "The mail server isn't answering right now. Try again in a moment.", 503)
    }
    throw err
  }
}

export async function jmap(
  env: StalwartEnv,
  calls: [method: string, args: JmapArgs][],
  using: string[] = MANAGEMENT_CAPABILITIES,
): Promise<JmapArgs[]> {
  const what = `jmap ${[...new Set(calls.map(([method]) => method))].join(',')}`
  const methodResponses = await stalwartFetch(
    new URL('/jmap/', env.STALWART_URL),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.STALWART_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        using,
        methodCalls: calls.map(([method, args], i) => [method, args, `c${i}`]),
      }),
    },
    { what, ms: JMAP_TIMEOUT_MS },
    async (res) => {
      if (!res.ok) {
        throw new EmailError('mail_server_error', `Mail server returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, 502)
      }
      return ((await res.json()) as { methodResponses: [string, JmapArgs, string][] }).methodResponses
    },
  )
  return methodResponses.map(([name, args]) => {
    if (name === 'error') {
      throw new EmailError('mail_server_error', `Mail server error (${String(args.type ?? 'unknown')}): ${describe(args)}`, 502)
    }
    return args
  })
}

export async function create(env: StalwartEnv, type: StalwartType, object: JmapArgs): Promise<string> {
  const [result] = await jmap(env, [[`${type}/set`, { create: { new: object } }]])
  const created = (result?.created as Record<string, { id: string }> | undefined)?.new
  if (!created) throw fromSetError((result?.notCreated as Record<string, SetError> | undefined)?.new)
  return created.id
}

export async function update(env: StalwartEnv, type: StalwartType, id: string, patch: JmapArgs): Promise<void> {
  const [result] = await jmap(env, [[`${type}/set`, { update: { [id]: patch } }]])
  const failed = (result?.notUpdated as Record<string, SetError> | undefined)?.[id]
  if (failed || !(result?.updated as Record<string, unknown> | undefined) || !(id in (result!.updated as object))) {
    throw fromSetError(failed)
  }
}

export async function destroy(env: StalwartEnv, type: StalwartType, ids: string | string[]): Promise<void> {
  ids = typeof ids === 'string' ? [ids] : ids
  if (!ids.length) return
  const [result] = await jmap(env, [[`${type}/set`, { destroy: ids }]])
  const failed = Object.values((result?.notDestroyed as Record<string, SetError> | undefined) ?? {})
  // Already gone on the mail server is fine: the goal is that it doesn't exist.
  const error = failed.find((e) => e.type !== 'notFound')
  if (error) throw fromSetError(error)
}

export async function query(env: StalwartEnv, type: StalwartType, filter: JmapArgs): Promise<string[]> {
  const [result] = await jmap(env, [[`${type}/query`, { filter }]])
  return (result?.ids as string[] | undefined) ?? []
}

/**
 * Stalwart sends and expects List fields (credentials, aliases) as objects keyed by position,
 * `{"0": {...}, "1": {...}}`, not JSON arrays.
 */
export function indexed<T>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((item, i) => [String(i), item]))
}

function fromSetError(error: SetError | undefined): EmailError {
  if (error?.type === 'alreadyExists') return new EmailError('already_exists', describe(error), 409)
  if (error?.type === 'notFound') return new EmailError('not_found_on_mail_server', describe(error), 404)
  if (error?.type === 'invalidProperties') return new EmailError('invalid', describe(error), 400)
  return new EmailError('mail_server_error', `Mail server rejected the change: ${describe(error ?? {})}`, 502)
}

function describe(error: { type?: unknown; description?: unknown; properties?: unknown }): string {
  const props = Array.isArray(error.properties) && error.properties.length ? ` (${error.properties.join(', ')})` : ''
  return `${String(error.description ?? error.type ?? 'unknown error')}${props}`
}
