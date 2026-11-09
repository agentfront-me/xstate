/**
 * An expected failure. The HTTP router and MCP server turn it into `{ error: { code, message, details? } }` with
 * `status`. `details` is structured data a client can act on (say, the DNS record to add).
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503 = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
