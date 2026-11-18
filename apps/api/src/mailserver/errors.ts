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
