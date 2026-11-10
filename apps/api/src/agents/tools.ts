// Built-in tools: existing operations (operations/define.ts), allowlisted.
//
// organizationId is filled in by the run, not chosen by the model, so an agent can't point a tool at another
// organization. Every call goes through the operation's own access checks as the person the run acts for, and on
// top of that through the agent's own scope: a tool call that names a mailbox must name one the agent may use
// (its Settings → Mailboxes plus the mailboxes its email triggers watch). Tools that change something can require a
// person's approval first (agents/run.ts); each has a default, which the agent's config can override.

import { z } from 'zod'
import { audienceGetPerson, audienceListPeople } from '../operations/audience'
import { calendarCreateEvent, calendarListEvents } from '../operations/calendar'
import type { AnyOperation } from '../operations/define'
import { emailCreateDraft, emailGetThread, emailListMessages, emailSend, emailUpdateMessage } from '../operations/email'
import { membersList } from '../operations/members'
import { storageSearch } from '../operations/storage'
import type { AgentConfig } from './config'

type Group = 'Email' | 'Contacts' | 'Storage' | 'Calendar' | 'Team'
type Builtin = { op: AnyOperation; label: string; group: Group; readOnly: boolean; approval: 'always' | 'never' }

const read = (op: unknown, label: string, group: Group): Builtin => ({ op: op as AnyOperation, label, group, readOnly: true, approval: 'never' })
const write = (op: unknown, label: string, group: Group, approval: 'always' | 'never'): Builtin => ({ op: op as AnyOperation, label, group, readOnly: false, approval })

const BUILTIN: Builtin[] = [
  read(emailListMessages, 'List emails', 'Email'),
  read(emailGetThread, 'Read an email thread', 'Email'),
  write(emailCreateDraft, 'Create a draft', 'Email', 'never'),
  write(emailSend, 'Send, reply or forward', 'Email', 'always'),
  write(emailUpdateMessage, 'Mark or move a message', 'Email', 'never'),
  read(audienceListPeople, 'Look up contacts', 'Contacts'),
  read(audienceGetPerson, 'Read a contact', 'Contacts'),
  read(storageSearch, 'Search storage and mail', 'Storage'),
  read(calendarListEvents, 'List calendar events', 'Calendar'),
  write(calendarCreateEvent, 'Create a calendar event', 'Calendar', 'always'),
  read(membersList, 'List team members', 'Team'),
]

export type ToolInfo = { name: string; label: string; group: string; description: string; readOnly: boolean; defaultApproval: 'always' | 'never' }

/** The catalog the Setup tab shows. */
export const builtinCatalog = (): ToolInfo[] =>
  BUILTIN.map((b) => ({ name: b.op.name, label: b.label, group: b.group, description: b.op.description, readOnly: b.readOnly, defaultApproval: b.approval }))

export type ToolDef = { name: string; label: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean; needsApproval: boolean }

/** What the model sees for the agent's chosen tools, and whether each needs approval. Unknown names are skipped. */
export function toolDefs(config: Pick<AgentConfig, 'tools'>): ToolDef[] {
  return BUILTIN.filter((b) => config.tools.builtin.includes(b.op.name)).map((b) => {
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
    return {
      name: b.op.name,
      label: b.label,
      description: b.op.description,
      inputSchema: schema,
      readOnly: b.readOnly,
      needsApproval: !b.readOnly && (config.tools.approval[b.op.name] ?? b.approval) === 'always',
    }
  })
}

/** Why the call is outside the agent's mailboxes, or the input with a missing mailboxId filled in. */
export function scopeInput(name: string, input: unknown, mailboxes: string[]): { input: Record<string, unknown> } | { error: string } {
  const builtin = BUILTIN.find((b) => b.op.name === name)
  if (!builtin) return { error: `Unknown tool ${name}` }
  const args = { ...(input && typeof input === 'object' ? (input as Record<string, unknown>) : {}) }
  const shape = (builtin.op.input as unknown as { shape?: Record<string, unknown> }).shape ?? {}
  const takesMailbox = 'mailboxId' in shape || 'mailboxId' in args
  if (!takesMailbox) return { input: args }
  const list = mailboxes.length ? mailboxes.join(', ') : 'none (add some in the agent’s Settings → Mailboxes)'
  if (args.mailboxId === undefined || args.mailboxId === null || args.mailboxId === '') {
    // Optional mailboxId means "every mailbox you can read": for an agent, only its own one (or ask).
    if (mailboxes.length === 1) return { input: { ...args, mailboxId: mailboxes[0] } }
    return { error: `Pass mailboxId: one of ${list}` }
  }
  if (!mailboxes.includes(String(args.mailboxId))) return { error: `This agent can't use mailbox ${String(args.mailboxId)}. It can use: ${list}` }
  return { input: args }
}

export async function runBuiltin(env: Env, userId: string, organizationId: string, name: string, input: Record<string, unknown>): Promise<unknown> {
  const builtin = BUILTIN.find((b) => b.op.name === name)
  if (!builtin) throw new Error(`Unknown tool ${name}`)
  const parsed: unknown = builtin.op.input.parse({ ...input, organizationId })
  // Operations ignore fields they don't declare, so the extra organizationId is harmless for mailbox-scoped tools.
  return builtin.op.run({ env, actor: { userId }, waitUntil: () => {} } as never, parsed)
}

export const toolLabel = (name: string) => BUILTIN.find((b) => b.op.name === name)?.label ?? name
