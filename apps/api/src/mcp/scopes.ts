// What the consent screen's choices mean as scopes. No imports beyond types, so the unit tests can run it.

import type { McpScope } from '../operations/define'

/** How much of one area a connected app gets. */
export type Level = 'off' | 'read' | 'write'

/** The consent screen's answers (docs/mcp-server-plan.md, Access). Mail can't be off: it is what xstate is for. */
export type Choices = {
  email: 'read' | 'draft' | 'send'
  calendar: Level
  storage: Level
  contacts: Level
  /** Domains, mailboxes and aliases. Only offered to owners and admins. */
  setup: boolean
}

/** What the screen starts on: read everything, write nothing but drafts. */
export const DEFAULT_CHOICES: Choices = { email: 'draft', calendar: 'read', storage: 'read', contacts: 'read', setup: false }

/** Every scope the choices give, spelled out: a grant never implies a scope it doesn't list. */
export function scopesFor(choices: Choices): McpScope[] {
  const scopes: McpScope[] = ['mail.read']
  if (choices.email !== 'read') scopes.push('mail.draft')
  if (choices.email === 'send') scopes.push('mail.send')
  for (const area of ['calendar', 'storage', 'contacts'] as const) {
    if (choices[area] !== 'off') scopes.push(`${area}.read`)
    if (choices[area] === 'write') scopes.push(`${area}.write`)
  }
  if (choices.setup) scopes.push('setup')
  return scopes
}
