// Settings → API keys → Personal Tokens (auth/api-tokens.ts). All off MCP and behind a signed-in session: an agent,
// a connected app or a token itself can't create a token, see one or change one.

import { z } from 'zod'
import { EXPIRES_IN } from '../auth/api-token-rules.ts'
import { createToken, listTokens, revokeToken, setTokensEnabled, updateToken } from '../auth/api-tokens'
import { defineOperation } from './define'

const id = z.string().min(1).max(64)
const name = z.string().trim().min(1, 'Give the token a name').max(80)
const mailboxIds = z.array(id).min(1, 'Choose at least one mailbox').max(50)
const truthy = z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')])

export const tokensList = defineOperation({
  name: 'tokens_list',
  description:
    'Your personal API tokens in the organization: name, last 4 characters, mailboxes, state (active, inactive when ' +
    'you can no longer send from any of its mailboxes, expired), when it was last used and when it ends. Never the ' +
    'token itself. Also whether tokens are turned on, and the mailboxes you could give a new one. Owners and ' +
    'admins can pass all=true for everyone’s.',
  input: z.object({ organizationId: id, all: truthy.default(false) }),
  http: { method: 'GET', path: '/orgs/:organizationId/tokens' },
  mcp: false,
  run: ({ env, actor }, input) => listTokens(env, actor, input.organizationId, input.all),
})

export const tokensCreate = defineOperation({
  name: 'tokens_create',
  description:
    'Create a personal API token that can send email from the chosen mailboxes, which must be ones you can send ' +
    'from. Returns the token once as `secret`: it is stored hashed and can never be shown again. expiresIn is 30d, ' +
    '90d, 1y or never. At most 20 per person.',
  input: z.object({ organizationId: id, name, mailboxIds, expiresIn: z.enum(EXPIRES_IN).default('never') }),
  http: { method: 'POST', path: '/orgs/:organizationId/tokens', status: 201 },
  mcp: false,
  run: ({ env, actor, waitUntil }, { organizationId, ...input }) => createToken(env, actor, organizationId, input, waitUntil),
})

export const tokensUpdate = defineOperation({
  name: 'tokens_update',
  description: 'Rename one of your tokens or change the mailboxes it can send from. The token itself stays the same.',
  input: z.object({ organizationId: id, tokenId: id, name: name.optional(), mailboxIds: mailboxIds.optional() }),
  http: { method: 'PATCH', path: '/orgs/:organizationId/tokens/:tokenId' },
  mcp: false,
  run: ({ env, actor }, { organizationId, tokenId, ...input }) => updateToken(env, actor, organizationId, tokenId, input),
})

export const tokensRevoke = defineOperation({
  name: 'tokens_revoke',
  description: 'Revoke a token: it stops working at once and can’t be brought back. Your own; owners and admins can revoke anyone’s.',
  input: z.object({ organizationId: id, tokenId: id }),
  http: { method: 'DELETE', path: '/orgs/:organizationId/tokens/:tokenId' },
  mcp: false,
  run: ({ env, actor }, input) => revokeToken(env, actor, input.organizationId, input.tokenId),
})

export const tokensSetEnabled = defineOperation({
  name: 'tokens_set_enabled',
  description:
    'Turn personal API tokens on or off for the whole organization. Off refuses every token until it is turned ' +
    'back on; none is deleted. Owners and admins only.',
  input: z.object({ organizationId: id, enabled: z.boolean() }),
  http: { method: 'PUT', path: '/orgs/:organizationId/tokens/settings' },
  mcp: false,
  run: ({ env, actor }, input) => setTokensEnabled(env, actor, input.organizationId, input.enabled),
})

export const tokenOperations = [tokensList, tokensCreate, tokensUpdate, tokensRevoke, tokensSetEnabled]
