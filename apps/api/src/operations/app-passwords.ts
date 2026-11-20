// Settings → Access → App passwords (auth/app-passwords.ts). All off MCP and behind a signed-in session: an agent, a
// connected app or a token can't create an app password, see one or change one.

import { z } from 'zod'
import { createAppPassword, listAppPasswords, revokeAppPassword, setMailAppsEnabled } from '../auth/app-passwords'
import { defineOperation } from './define'

const id = z.string().min(1).max(64)
const truthy = z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')])

export const appPasswordsList = defineOperation({
  name: 'app_passwords_list',
  description:
    'Your app passwords in the organization (the passwords mail and calendar apps sign in with): name, when each ' +
    'was created and last used. Never the password itself. Also whether mail apps are turned on, and the server ' +
    'to type into a mail app. Owners and admins can pass all=true for everyone’s.',
  input: z.object({ organizationId: id, all: truthy.default(false) }),
  http: { method: 'GET', path: '/orgs/:organizationId/app-passwords' },
  mcp: false,
  run: ({ env, actor }, input) => listAppPasswords(env, actor, input.organizationId, input.all),
})

export const appPasswordsCreate = defineOperation({
  name: 'app_passwords_create',
  description:
    'Create an app password for a mail or calendar app. It works for every mailbox you can open, with the mailbox’s ' +
    'address as the username. Returns it once as `secret`: it is stored hashed and can never be shown again. At ' +
    'most 20 per person.',
  input: z.object({ organizationId: id, name: z.string().trim().min(1, 'Give the app password a name').max(80) }),
  http: { method: 'POST', path: '/orgs/:organizationId/app-passwords', status: 201 },
  mcp: false,
  run: ({ env, actor, waitUntil }, { organizationId, ...input }) => createAppPassword(env, actor, organizationId, input, waitUntil),
})

export const appPasswordsRevoke = defineOperation({
  name: 'app_passwords_revoke',
  description: 'Revoke an app password: the app using it is refused from its next sign-in. Your own; owners and admins can revoke anyone’s.',
  input: z.object({ organizationId: id, passwordId: id }),
  http: { method: 'DELETE', path: '/orgs/:organizationId/app-passwords/:passwordId' },
  mcp: false,
  run: ({ env, actor }, input) => revokeAppPassword(env, actor, input.organizationId, input.passwordId),
})

export const appPasswordsSetEnabled = defineOperation({
  name: 'app_passwords_set_enabled',
  description:
    'Turn mail and calendar apps on or off for the whole organization. Off refuses every app password until it is ' +
    'turned back on; none is deleted. Owners and admins only.',
  input: z.object({ organizationId: id, enabled: z.boolean() }),
  http: { method: 'PUT', path: '/orgs/:organizationId/app-passwords/settings' },
  mcp: false,
  run: ({ env, actor }, input) => setMailAppsEnabled(env, actor, input.organizationId, input.enabled),
})

export const appPasswordOperations = [appPasswordsList, appPasswordsCreate, appPasswordsRevoke, appPasswordsSetEnabled]
