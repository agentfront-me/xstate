// Built-in tools: existing operations (operations/define.ts), allowlisted. Phase 1 has read-only ones only; actions
// (reply, draft, forward, label, calendar) come with approvals in Phase 3.
//
// organizationId is filled in by the run, not chosen by the model, so an agent can't point a tool at another
// organization. Every call goes through the operation's own access checks, as the person the run acts for.

import { z } from 'zod'
import { audienceGetPerson, audienceListPeople } from '../operations/audience'
import { calendarListEvents } from '../operations/calendar'
import type { AnyOperation } from '../operations/define'
import { emailGetThread, emailListMessages } from '../operations/email'
import { membersList } from '../operations/members'
import { storageSearch } from '../operations/storage'

type Builtin = { op: AnyOperation; label: string; group: 'Email' | 'Contacts' | 'Storage' | 'Calendar' | 'Team' }

const BUILTIN: Builtin[] = [
  { op: emailListMessages as AnyOperation, label: 'List emails', group: 'Email' },
  { op: emailGetThread as AnyOperation, label: 'Read an email thread', group: 'Email' },
  { op: audienceListPeople as AnyOperation, label: 'Look up contacts', group: 'Contacts' },
  { op: audienceGetPerson as AnyOperation, label: 'Read a contact', group: 'Contacts' },
  { op: storageSearch as AnyOperation, label: 'Search storage and mail', group: 'Storage' },
  { op: calendarListEvents as AnyOperation, label: 'List calendar events', group: 'Calendar' },
  { op: membersList as AnyOperation, label: 'List team members', group: 'Team' },
]

export type ToolInfo = { name: string; label: string; group: string; description: string; readOnly: boolean }

/** The catalog the Setup tab shows. */
export const builtinCatalog = (): ToolInfo[] =>
  BUILTIN.map((b) => ({ name: b.op.name, label: b.label, group: b.group, description: b.op.description, readOnly: !!(b.op.mcp && b.op.mcp.readOnly) }))

export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }

/** What the model sees for the agent's chosen tools. Unknown names (a tool removed since) are skipped. */
export function toolDefs(names: string[]): ToolDef[] {
  return BUILTIN.filter((b) => names.includes(b.op.name)).map((b) => {
    const schema = z.toJSONSchema(b.op.input, { io: 'input', unrepresentable: 'any' }) as {
      properties?: Record<string, unknown>
      required?: string[]
      [k: string]: unknown
    }
    if (schema.properties?.organizationId) {
      delete schema.properties.organizationId
      schema.required = schema.required?.filter((r) => r !== 'organizationId')
    }
    delete schema.$schema
    return { name: b.op.name, description: b.op.description, inputSchema: schema, readOnly: !!(b.op.mcp && b.op.mcp.readOnly) }
  })
}

export async function runBuiltin(env: Env, userId: string, organizationId: string, name: string, input: unknown): Promise<unknown> {
  const builtin = BUILTIN.find((b) => b.op.name === name)
  if (!builtin) throw new Error(`Unknown tool ${name}`)
  const args = { ...(input && typeof input === 'object' ? input : {}), organizationId }
  const parsed: unknown = builtin.op.input.parse(args)
  // Operations ignore fields they don't declare, so the extra organizationId is harmless for mailbox-scoped tools.
  return builtin.op.run({ env, actor: { userId }, waitUntil: () => {} } as never, parsed)
}
