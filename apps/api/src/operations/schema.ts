import { z } from 'zod'
import type { AnyOperation } from './define'

export type JsonSchema = { type?: string; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown }

/**
 * An operation's input as JSON Schema, the way a model sees it as a tool (xstate's own agents and MCP).
 * organizationId is left out: it comes from the run or the connection, never from the model.
 */
export function toolInputSchema(operation: Pick<AnyOperation, 'input'>): JsonSchema {
  const schema = z.toJSONSchema(operation.input, { io: 'input', unrepresentable: 'any' }) as JsonSchema
  if (schema.properties?.organizationId) {
    delete schema.properties.organizationId
    schema.required = schema.required?.filter((name) => name !== 'organizationId')
  }
  delete schema.$schema
  return schema
}
