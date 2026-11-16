// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { inMailboxScope } from '../auth/scope.ts'
import type { AnyOperation, McpScope } from '../operations/define.ts'
import { grantedOperations, toolError, toolFor, toolInput, toolResult } from './tools.ts'

const op = (name: string, mcp: AnyOperation['mcp'], extra: Partial<AnyOperation> = {}): AnyOperation => ({
  name,
  description: `${name} description`,
  input: z.object({ organizationId: z.string(), q: z.string().optional() }),
  mcp,
  run: async () => ({}),
  ...extra,
})

const OPS = [
  op('auth_me', { scope: 'profile', readOnly: true }),
  op('email_list_messages', { scope: 'mail.read', readOnly: true }),
  op('email_create_draft', { scope: 'mail.draft' }),
  op('email_send', { scope: 'mail.send' }),
  op('email_delete_mailbox', { scope: 'setup', destructive: true }),
  op('email_set_mailbox_password', false),
  op('auth_login', { scope: 'profile' }, { public: true }),
]
const names = (scopes: McpScope[]) => grantedOperations(OPS, { scopes }).map((o) => o.name)

describe('grantedOperations', () => {
  it('lists exactly what the grant covers, and profile tools always', () => {
    assert.deepEqual(names([]), ['auth_me'])
    assert.deepEqual(names(['mail.read', 'mail.draft']), ['auth_me', 'email_list_messages', 'email_create_draft'])
  })
  it('does not treat a wider scope as including a narrower one: grants spell out every scope', () => {
    assert.deepEqual(names(['mail.send']), ['auth_me', 'email_send'])
  })
  it('never lists operations kept off MCP or ones that need no sign-in', () => {
    const all = names(['mail.read', 'mail.draft', 'mail.send', 'setup', 'profile'])
    assert.equal(all.includes('email_set_mailbox_password'), false)
    assert.equal(all.includes('auth_login'), false)
    assert.equal(all.includes('email_delete_mailbox'), true)
  })
})

describe('toolFor', () => {
  it('hides organizationId from the model and keeps the rest of the schema', () => {
    const tool = toolFor(op('x', { scope: 'mail.read' }, { input: z.object({ organizationId: z.string(), mailboxId: z.string(), limit: z.number().optional() }) }))
    assert.equal(tool.inputSchema.type, 'object')
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ['mailboxId', 'limit'])
    assert.deepEqual(tool.inputSchema.required, ['mailboxId'])
    assert.equal('$schema' in tool.inputSchema, false)
  })
  it('describes schemas with refinements and transforms', () => {
    const input = z.object({ seen: z.boolean().optional(), n: z.coerce.number().default(5) }).refine((v) => v.seen !== undefined, 'Nothing to change')
    assert.deepEqual(Object.keys(toolFor(op('x', { scope: 'mail.draft' }, { input })).inputSchema.properties ?? {}), ['seen', 'n'])
  })
  it('passes on the hints', () => {
    assert.deepEqual(toolFor(OPS[1]!).annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    assert.deepEqual(toolFor(OPS[4]!).annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: false })
    assert.equal(toolFor(OPS[3]!).annotations.openWorldHint, true)
  })
})

describe('toolInput', () => {
  it('always uses the connection’s organization', () => {
    assert.deepEqual(toolInput({ organizationId: 'org-a' }, { organizationId: 'org-b', q: 'hi' }), { organizationId: 'org-a', q: 'hi' })
    assert.deepEqual(toolInput({ organizationId: 'org-a' }, undefined), { organizationId: 'org-a' })
    assert.deepEqual(toolInput({ organizationId: 'org-a' }, ['x']), { organizationId: 'org-a' })
  })
})

describe('results', () => {
  it('returns objects as text and structured content', () => {
    const result = toolResult({ messages: [{ id: 'm1', at: new Date(0) }] })
    assert.equal(result.content[0]!.text, '{"messages":[{"id":"m1","at":"1970-01-01T00:00:00.000Z"}]}')
    assert.deepEqual(result.structuredContent, { messages: [{ id: 'm1', at: '1970-01-01T00:00:00.000Z' }] })
  })
  it('returns lists as text only, and says so when there is nothing to return', () => {
    assert.equal(toolResult([1, 2]).structuredContent, undefined)
    assert.equal(toolResult(undefined).content[0]!.text, 'Done.')
  })
  it('marks errors and keeps the code the model can act on', () => {
    const result = toolError('mailbox_not_found', 'Mailbox not found')
    assert.equal(result.isError, true)
    assert.deepEqual(JSON.parse(result.content[0]!.text), { error: { code: 'mailbox_not_found', message: 'Mailbox not found' } })
  })
})

describe('inMailboxScope', () => {
  it('lets a person signed in themselves use any mailbox', () => assert.equal(inMailboxScope({}, 'a'), true))
  it('keeps a connection to the mailboxes it was given', () => {
    assert.equal(inMailboxScope({ mailboxIds: ['a'] }, 'a'), true)
    assert.equal(inMailboxScope({ mailboxIds: ['a'] }, 'b'), false)
    assert.equal(inMailboxScope({ mailboxIds: [] }, 'a'), false)
  })
})
