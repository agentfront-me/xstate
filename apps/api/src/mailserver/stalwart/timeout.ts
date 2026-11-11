// Time limits for calls to the mail server, and a log line whenever one runs out.
//
// A fetch on Workers has no time limit of its own: on 2026-11-11 the link to deepo stalled for a moment and requests
// sat waiting until Cloudflare shut the instance down, up to 15 minutes later. With a limit, a stalled call fails
// after a few seconds with a clear error, and the log says which call it was.
//
// No imports, so it also runs under Node for the tests; ./client turns MailServerTimeout into an API error.
// pnpm --filter @xstate/api test

/** A call to the mail server that didn't answer within its time limit (already logged). */
export class MailServerTimeout extends Error {
  readonly what: string
  readonly waitedMs: number
  constructor(what: string, waitedMs: number) {
    super(`Mail server didn't answer ${what} within ${Math.round(waitedMs / 1000)}s`)
    this.name = 'MailServerTimeout'
    this.what = what
    this.waitedMs = waitedMs
  }
}

export type Limit = {
  /** Names the call in the log line and the error, e.g. "jmap Email/get". */
  what: string
  ms: number
  /**
   * Only wait this long for the response headers; the body may then take as long as it needs. For downloads, which
   * stream the body straight to the browser and can be large.
   */
  untilHeaders?: boolean
}

/**
 * fetch() with a time limit. Returns the response; with `untilHeaders` unset the limit also covers reading the body,
 * so read it inside `read`, which runs under the same limit. Throws MailServerTimeout (and logs it) when the limit
 * runs out, and logs other network failures before rethrowing them.
 */
export async function fetchWithin<T = Response>(
  input: string | URL,
  init: RequestInit,
  limit: Limit,
  read: (res: Response) => Promise<T> = async (res) => res as T,
): Promise<T> {
  const controller = new AbortController()
  const started = Date.now()
  const timer = setTimeout(() => controller.abort(), limit.ms)
  const timedOut = () => {
    const waitedMs = Date.now() - started
    console.error('stalwart: timed out', JSON.stringify({ what: limit.what, path: pathOf(input), limitMs: limit.ms, waitedMs }))
    return new MailServerTimeout(limit.what, waitedMs)
  }
  try {
    let res: Response
    try {
      res = await fetch(input, { ...init, signal: controller.signal })
    } catch (err) {
      if (controller.signal.aborted) throw timedOut()
      // Couldn't reach the server at all (connection refused, reset, DNS).
      console.error('stalwart: request failed', JSON.stringify({ what: limit.what, path: pathOf(input), waitedMs: Date.now() - started, error: String(err) }))
      throw err
    }
    if (limit.untilHeaders) clearTimeout(timer)
    try {
      return await read(res)
    } catch (err) {
      // An error `read` throws itself (an HTTP status it refuses) passes through untouched.
      if (controller.signal.aborted && !limit.untilHeaders) throw timedOut()
      throw err
    }
  } finally {
    clearTimeout(timer)
  }
}

/** The first two path segments only (/jmap/download): no host, query, account ids or file names. */
function pathOf(input: string | URL): string {
  try {
    return new URL(String(input)).pathname.split('/').slice(0, 3).join('/')
  } catch {
    return '?'
  }
}
