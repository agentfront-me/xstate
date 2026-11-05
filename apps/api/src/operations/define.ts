// An operation is one thing the API can do, defined once and exposed as an HTTP route and an MCP tool.
// The services do the work; an operation only names it, describes it, validates its input and says where it lives.

import type { z } from 'zod'
import type { Actor } from '../auth/types'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** `waitUntil` keeps background work (e.g. creating a bucket after sign-up) running after the response is sent. */
type Background = { waitUntil: (promise: Promise<unknown>) => void }

export type OperationContext<Public extends boolean> = Public extends true
  ? { env: Env; actor?: undefined } & Background
  : { env: Env; actor: Actor } & Background

export type Operation<Input extends z.ZodType = z.ZodType, Public extends boolean = boolean> = {
  /** Unique, snake_case, prefixed by area (`email_…`). Also the MCP tool name. */
  name: string
  /** What it does and returns. Agents read this to decide when to call the tool, so be specific. */
  description: string
  /** Validates the merged path params, query and JSON body (HTTP) or the tool arguments (MCP). */
  input: Input
  /** Callable without a token. Defaults to false: the auth middleware runs first and `ctx.actor` is set. */
  public?: Public
  /** Path is relative to /v1. `status` is used for a non-empty result; an undefined result returns 204. */
  http?: { method: HttpMethod; path: string; status?: 200 | 201 }
  /** Hints for MCP clients, or false to keep this operation off MCP. */
  mcp?: false | { readOnly?: boolean; destructive?: boolean }
  run(ctx: OperationContext<Public>, input: z.output<Input>): Promise<unknown>
}

export type AnyOperation = Operation<z.ZodType, boolean>

export function defineOperation<Input extends z.ZodType, Public extends boolean = false>(
  operation: Operation<Input, Public>,
): Operation<Input, Public> {
  return operation
}
