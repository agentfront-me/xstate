// An operation is one thing the API can do, defined once and exposed as an HTTP route and an MCP tool.
// The services do the work; an operation only names it, describes it, validates its input and says where it lives.

import type { z } from 'zod'
import type { Actor } from '../auth/types'

/**
 * What a person can let a connected app do, picked on the consent screen (docs/mcp-server-plan.md). A grant lists
 * every scope it has: "draft and send" is mail.read, mail.draft and mail.send. `profile` (who you are, who is in the
 * organization) comes with every connection. `setup` is domains, mailboxes and aliases, for owners and admins.
 */
export const MCP_SCOPES = [
  'profile',
  'mail.read',
  'mail.draft',
  'mail.send',
  'calendar.read',
  'calendar.write',
  'storage.read',
  'storage.write',
  'contacts.read',
  'contacts.write',
  'setup',
] as const
export type McpScope = (typeof MCP_SCOPES)[number]

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * `waitUntil` keeps background work (e.g. creating a bucket after sign-up) running after the response is sent.
 * `ip` is the caller's IP (CF-Connecting-IP) for HTTP calls, used for rate limits; unset for MCP and agent calls.
 */
type Background = { waitUntil: (promise: Promise<unknown>) => void; ip?: string }

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
  /**
   * false keeps this operation off MCP. Otherwise `scope` is what a connection must have been granted for the tool
   * to be listed and callable (mcp/tools.ts), and the rest are hints for MCP clients.
   */
  mcp: false | { scope: McpScope; readOnly?: boolean; destructive?: boolean }
  run(ctx: OperationContext<Public>, input: z.output<Input>): Promise<unknown>
}

export type AnyOperation = Operation<z.ZodType, boolean>

export function defineOperation<Input extends z.ZodType, Public extends boolean = false>(
  operation: Operation<Input, Public>,
): Operation<Input, Public> {
  return operation
}
