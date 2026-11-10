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
import type { ConnectorTool } from './connectors'
import { connectorToolName, matches, type Condition } from './rules'

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

export type ToolSource = { kind: 'builtin' } | { kind: 'memory' } | { kind: 'connector'; connectorId: string; connectorName: string; tool: string }

export type ToolDef = {
  /** The name the model sees. */
  name: string
  label: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
  source: ToolSource
  /** Key in config.tools.approval / conditions. */
  key: string
  approval: { mode: 'always' | 'never' | 'when'; condition?: Condition }
}

/** A connector as runs need it: the tools it offered at the last discovery. */
export type RunConnector = { id: string; name: string; tools: ConnectorTool[] }

function approvalFor(config: Pick<AgentConfig, 'tools'>, key: string, readOnly: boolean, fallback: 'always' | 'never'): ToolDef['approval'] {
  if (readOnly) return { mode: 'never' }
  const mode = config.tools.approval[key] ?? fallback
  const condition = config.tools.conditions[key]
  return mode === 'when' && condition ? { mode, condition } : { mode: mode === 'when' ? 'always' : mode }
}

/** Whether this call has to wait for a person. */
export function requiresApproval(def: ToolDef, input: unknown): boolean {
  if (def.approval.mode === 'always') return true
  if (def.approval.mode === 'when' && def.approval.condition) return matches(def.approval.condition, input)
  return false
}

/**
 * What the model sees for the agent's chosen tools, and how each is approved. Unknown names (a tool removed since)
 * are skipped. Connector tools that changed nothing are read-only by their readOnlyHint; the rest default to asking.
 */
export function toolDefs(config: Pick<AgentConfig, 'tools'> & Partial<Pick<AgentConfig, 'memory'>>, connectors: RunConnector[] = []): ToolDef[] {
  const taken = new Set([...BUILTIN.map((b) => b.op.name), ...MEMORY_TOOLS.map((t) => t.name)])
  const fromConnectors: ToolDef[] = connectors.flatMap((c) =>
    (config.tools.connectors[c.id] ?? []).flatMap((toolName) => {
      const t = c.tools.find((x) => x.name === toolName)
      if (!t) return []
      const key = `${c.id}/${t.name}`
      return [
        {
          name: connectorToolName(c.name, t.name, taken),
          label: `${c.name}: ${t.title ?? t.name}`,
          description: `${t.description} (from the ${c.name} connector)`,
          inputSchema: t.inputSchema,
          readOnly: t.readOnly,
          source: { kind: 'connector', connectorId: c.id, connectorName: c.name, tool: t.name },
          key,
          approval: approvalFor(config, key, t.readOnly, 'always'),
        } satisfies ToolDef,
      ]
    }),
  )
  return [...builtinDefs(config), ...(config.memory?.enabled ? MEMORY_TOOLS : []), ...fromConnectors]
}

/**
 * Memory: facts the agent keeps between runs, in its own Durable Object (agents/store.ts). Turned on in the agent's
 * Settings. They change only the agent's own notes, so they never ask for approval; a dry run doesn't save them.
 */
export const MEMORY_TOOLS: ToolDef[] = [
  {
    name: 'memory_remember',
    label: 'Remember a fact',
    description:
      'Save a short fact to use in later runs, such as a customer’s preference or a decision. subject is who or what it is about: an email address for a person, otherwise a short name like "company" or "pricing". Saving the same subject and fact again just refreshes it.',
    inputSchema: {
      type: 'object',
      properties: { subject: { type: 'string', maxLength: 200 }, fact: { type: 'string', maxLength: 1000 } },
      required: ['subject', 'fact'],
      additionalProperties: false,
    },
    readOnly: false,
    source: { kind: 'memory' },
    key: 'memory_remember',
    approval: { mode: 'never' },
  },
  {
    name: 'memory_recall',
    label: 'Recall facts',
    description: 'Look up facts saved in earlier runs. Give a subject (like an email address), words to search for, or both. Returns up to 20 facts with their ids, newest first.',
    inputSchema: {
      type: 'object',
      properties: { subject: { type: 'string', maxLength: 200 }, query: { type: 'string', maxLength: 200 } },
      additionalProperties: false,
    },
    readOnly: true,
    source: { kind: 'memory' },
    key: 'memory_recall',
    approval: { mode: 'never' },
  },
  {
    name: 'memory_forget',
    label: 'Forget a fact',
    description: 'Delete a saved fact that is wrong or out of date, by the id memory_recall returned.',
    inputSchema: { type: 'object', properties: { factId: { type: 'string', maxLength: 64 } }, required: ['factId'], additionalProperties: false },
    readOnly: false,
    source: { kind: 'memory' },
    key: 'memory_forget',
    approval: { mode: 'never' },
  },
]

function builtinDefs(config: Pick<AgentConfig, 'tools'>): ToolDef[] {
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
      source: { kind: 'builtin' } as const,
      key: b.op.name,
      approval: approvalFor(config, b.op.name, b.readOnly, b.approval),
    }
  })
}

/** Why the call is outside the agent's mailboxes, or the input with a missing mailboxId filled in. */
export function scopeInput(name: string, input: unknown, mailboxes: string[]): { input: Record<string, unknown> } | { error: string } {
  const builtin = BUILTIN.find((b) => b.op.name === name)
  const args0 = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  // Connector tools take whatever their server defines; mailbox scope is about xstate's own mail.
  if (!builtin) return { input: { ...args0 } }
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
