/** An expected failure. The HTTP router and MCP server turn it into `{ error: { code, message } }` with `status`. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 502 | 503 = 400,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
