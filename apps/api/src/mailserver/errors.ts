import { ApiError } from '../errors'

/** Thrown for every expected mail server failure. `status` is the HTTP status to return. */
export class EmailError extends ApiError {
  constructor(code: string, message: string, status: ApiError['status'] = 400) {
    super(code, message, status)
    this.name = 'EmailError'
  }
}

export function notFound(what: string): EmailError {
  return new EmailError(`${what}_not_found`, `${what[0]!.toUpperCase()}${what.slice(1)} not found`, 404)
}

export function forbidden(message: string): EmailError {
  return new EmailError('forbidden', message, 403)
}

/**
 * Runs a D1 write after a mail server change; if it fails, runs `undo` to reverse the mail server change and
 * rethrows, so Stalwart and D1 don't drift apart.
 */
export async function withRollback<T>(write: () => Promise<T>, undo: () => Promise<unknown>): Promise<T> {
  try {
    return await write()
  } catch (err) {
    await undo().catch((undoErr) => console.error('mailserver: undoing mail server change failed', undoErr))
    throw err
  }
}
