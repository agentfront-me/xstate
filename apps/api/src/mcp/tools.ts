// Operations as MCP tools: which ones a connection gets, what a client sees, and the shape of results.
// Kept free of the MCP SDK and of Workers bindings so it runs in the unit tests; mcp/server.ts wires it up.

import type { AnyOperation, McpScope } from '../operations/define'
import { toolInputSchema, type JsonSchema } from '../operations/schema.ts'

/** What a connected app was given on the consent screen. Fixed for the life of the connection. */
export type Grant = {
  userId: string
  /** Every tool call acts in this organization, whatever the model passes. */
  organizationId: string
  scopes: readonly McpScope[]
  /** The mailboxes whose mail and calendars it may use (Actor.mailboxIds). */
  mailboxIds: readonly string[]
  /** The app's name as shown on the consent page, for logs. Missing on grants made before it was stored. */
  app?: string
}

/** Who is calling, besides the grant: the OAuth client id of the connected app. */
export type Caller = { clientId: string }

/** One connection's rate-limit key: a person, an app and an organization (one grant per app per organization). */
export const rateKey = (grant: Pick<Grant, 'userId' | 'organizationId'>, caller: Caller) => `${grant.userId}:${caller.clientId}:${grant.organizationId}`

export type Tool = {
  name: string
  description: string
  inputSchema: JsonSchema & { type: 'object' }
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }
}

export type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** The operations a connection may list and call: on MCP, signed-in, and inside what was granted. */
export function grantedOperations(operations: readonly AnyOperation[], grant: Pick<Grant, 'scopes'>): AnyOperation[] {
  return operations.filter((op) => op.mcp !== false && !op.public && (op.mcp.scope === 'profile' || grant.scopes.includes(op.mcp.scope)))
}

export function toolFor(operation: AnyOperation): Tool {
  const hints: { readOnly?: boolean; destructive?: boolean } = operation.mcp === false ? {} : operation.mcp
  return {
    name: operation.name,
    description: operation.description,
    inputSchema: { ...toolInputSchema(operation), type: 'object' },
    annotations: {
      readOnlyHint: !!hints.readOnly,
      destructiveHint: !!hints.destructive,
      // Sending mail and inviting guests reach people outside xstate.
      openWorldHint: operation.name === 'email_send' || (operation.name.startsWith('calendar_') && !hints.readOnly),
    },
  }
}

/** The model's arguments with the connection's organization put in, ready for the operation's own validation. */
export function toolInput(grant: Pick<Grant, 'organizationId'>, args: unknown): Record<string, unknown> {
  const given = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  return { ...given, organizationId: grant.organizationId }
}

/** An operation's result as a tool result: the JSON as text for every client, and as structured content. */
export function toolResult(result: unknown): ToolResult {
  if (result === undefined || result === null) return { content: [{ type: 'text', text: 'Done.' }] }
  const text = JSON.stringify(result)
  const structured = typeof result === 'object' && !Array.isArray(result) ? (JSON.parse(text) as Record<string, unknown>) : undefined
  return { content: [{ type: 'text', text }], ...(structured && { structuredContent: structured }) }
}

/** A failure the model can read and act on (a wrong id, a missing field, no access), not a protocol error. */
export function toolError(code: string, message: string, details?: Record<string, unknown>): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...(details && { details }) } }) }] }
}
