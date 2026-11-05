import { z } from 'zod'
import * as mailserver from '../mailserver'
import { defineOperation } from './define'

const id = z.string().min(1).max(64)
const kind = z.enum(['personal', 'shared', 'agent'])
const password = z.string().min(8, 'Password must be at least 8 characters').max(256)
const localPart = z.string().trim().min(1).max(64)

// Domains

export const emailAddDomain = defineOperation({
  name: 'email_add_domain',
  description:
    'Add a domain the organization owns (e.g. customer.com) to xstate mail. Returns the domain with status "pending"; ' +
    'call email_get_dns_records next to get the records the owner must add at their DNS provider.',
  input: z.object({ organizationId: id, name: z.string().trim().min(3).max(253) }),
  http: { method: 'POST', path: '/email/orgs/:organizationId/domains', status: 201 },
  run: async ({ env, actor }, input) => ({ domain: await mailserver.addDomain(env, actor, input.organizationId, input.name) }),
})

export const emailListDomains = defineOperation({
  name: 'email_list_domains',
  description: "List the organization's domains that you can see.",
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/email/orgs/:organizationId/domains' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({ domains: await mailserver.listDomains(env, actor, input.organizationId) }),
})

export const emailGetDomain = defineOperation({
  name: 'email_get_domain',
  description: 'Get one domain: its name, verification status and whether mail is enabled.',
  input: z.object({ domainId: id }),
  http: { method: 'GET', path: '/email/domains/:domainId' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({ domain: await mailserver.getDomain(env, actor, input.domainId) }),
})

export const emailGetDnsRecords = defineOperation({
  name: 'email_get_dns_records',
  description:
    'Get the DNS records (MX, SPF, DKIM, DMARC, SRV, MTA-STS, autoconfig) the domain owner must add, as a zone file.',
  input: z.object({ domainId: id }),
  http: { method: 'GET', path: '/email/domains/:domainId/dns' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({ zoneFile: await mailserver.getDomainDnsRecords(env, actor, input.domainId) }),
})

export const emailSetDomainEnabled = defineOperation({
  name: 'email_set_domain_enabled',
  description: 'Turn mail for a domain on or off. Turning it off stops delivery but deletes nothing.',
  input: z.object({ domainId: id, enabled: z.boolean() }),
  http: { method: 'PATCH', path: '/email/domains/:domainId' },
  run: async ({ env, actor }, input) => ({
    domain: await mailserver.setDomainEnabled(env, actor, input.domainId, input.enabled),
  }),
})

export const emailRemoveDomain = defineOperation({
  name: 'email_remove_domain',
  description: 'Remove a domain from xstate. Fails while any mailbox or alias still uses it.',
  input: z.object({ domainId: id }),
  http: { method: 'DELETE', path: '/email/domains/:domainId' },
  mcp: { destructive: true },
  run: ({ env, actor }, input) => mailserver.removeDomain(env, actor, input.domainId),
})

// Mailboxes

export const emailCreateMailbox = defineOperation({
  name: 'email_create_mailbox',
  description:
    'Create a mailbox on a domain. "personal" is one person\'s inbox and needs a password; "shared" (e.g. hello@, ' +
    'support@) has no password and is opened by members you grant access to; "agent" is for an AI agent and gets a ' +
    'generated password if none is given, returned once in the response.',
  input: z.object({
    domainId: id,
    kind,
    localPart,
    displayName: z.string().trim().min(1).max(100).optional(),
    password: password.optional(),
    quotaBytes: z.number().int().positive().nullable().optional(),
    ownerMemberId: id.optional(),
  }),
  http: { method: 'POST', path: '/email/domains/:domainId/mailboxes', status: 201 },
  run: ({ env, actor }, input) => mailserver.createMailbox(env, actor, input),
})

export const emailListMailboxes = defineOperation({
  name: 'email_list_mailboxes',
  description: 'List the mailboxes in the organization that you can see, optionally only one domain or kind.',
  input: z.object({ organizationId: id, domainId: id.optional(), kind: kind.optional() }),
  http: { method: 'GET', path: '/email/orgs/:organizationId/mailboxes' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, { organizationId, ...filter }) => ({
    mailboxes: await mailserver.listMailboxes(env, actor, organizationId, filter),
  }),
})

export const emailGetMailbox = defineOperation({
  name: 'email_get_mailbox',
  description: 'Get one mailbox: its address, aliases, kind, display name and quota.',
  input: z.object({ mailboxId: id }),
  http: { method: 'GET', path: '/email/mailboxes/:mailboxId' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({ mailbox: await mailserver.getMailbox(env, actor, input.mailboxId) }),
})

export const emailUpdateMailbox = defineOperation({
  name: 'email_update_mailbox',
  description: 'Change a mailbox\'s display name or storage quota in bytes (null removes the limit).',
  input: z.object({
    mailboxId: id,
    displayName: z.string().trim().min(1).max(100).nullable().optional(),
    quotaBytes: z.number().int().positive().nullable().optional(),
  }),
  http: { method: 'PATCH', path: '/email/mailboxes/:mailboxId' },
  run: async ({ env, actor }, { mailboxId, ...changes }) => ({
    mailbox: await mailserver.updateMailbox(env, actor, mailboxId, changes),
  }),
})

export const emailSetMailboxPassword = defineOperation({
  name: 'email_set_mailbox_password',
  description: 'Reset the password of a personal or agent mailbox. Its mail apps must sign in again.',
  input: z.object({ mailboxId: id, password }),
  http: { method: 'PUT', path: '/email/mailboxes/:mailboxId/password' },
  run: ({ env, actor }, input) => mailserver.setMailboxPassword(env, actor, input.mailboxId, input.password),
})

export const emailDeleteMailbox = defineOperation({
  name: 'email_delete_mailbox',
  description: 'Permanently delete a mailbox with all its mail and addresses. This cannot be undone.',
  input: z.object({ mailboxId: id }),
  http: { method: 'DELETE', path: '/email/mailboxes/:mailboxId' },
  mcp: { destructive: true },
  run: ({ env, actor }, input) => mailserver.deleteMailbox(env, actor, input.mailboxId),
})

// Aliases

export const emailAddAlias = defineOperation({
  name: 'email_add_alias',
  description: 'Add an extra address to a mailbox, on any domain of the organization. Mail to it lands in the mailbox.',
  input: z.object({ mailboxId: id, localPart, domainId: id }),
  http: { method: 'POST', path: '/email/mailboxes/:mailboxId/aliases', status: 201 },
  run: async ({ env, actor }, { mailboxId, ...alias }) => ({
    mailbox: await mailserver.addAlias(env, actor, mailboxId, alias),
  }),
})

export const emailRemoveAlias = defineOperation({
  name: 'email_remove_alias',
  description: 'Remove an alias address from a mailbox. Mail sent to it will bounce.',
  input: z.object({ mailboxId: id, address: z.string().trim().min(3).max(320) }),
  http: { method: 'DELETE', path: '/email/mailboxes/:mailboxId/aliases/:address' },
  mcp: { destructive: true },
  run: async ({ env, actor }, input) => ({
    mailbox: await mailserver.removeAlias(env, actor, input.mailboxId, input.address),
  }),
})

// Shared mailbox access

export const emailListAccess = defineOperation({
  name: 'email_list_access',
  description: 'List the members who can open a mailbox, and their access (owner or full).',
  input: z.object({ mailboxId: id }),
  http: { method: 'GET', path: '/email/mailboxes/:mailboxId/access' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({ access: await mailserver.listMailboxAccess(env, actor, input.mailboxId) }),
})

export const emailGrantAccess = defineOperation({
  name: 'email_grant_access',
  description:
    'Let a member open a shared mailbox from their own mail app. They get full access (read, send, organize).',
  input: z.object({ mailboxId: id, memberId: id }),
  http: { method: 'PUT', path: '/email/mailboxes/:mailboxId/access/:memberId' },
  run: ({ env, actor }, input) => mailserver.grantMailboxAccess(env, actor, input.mailboxId, input.memberId),
})

export const emailRevokeAccess = defineOperation({
  name: 'email_revoke_access',
  description: "Stop a member from opening a shared mailbox. A mailbox owner's access can't be revoked.",
  input: z.object({ mailboxId: id, memberId: id }),
  http: { method: 'DELETE', path: '/email/mailboxes/:mailboxId/access/:memberId' },
  mcp: { destructive: true },
  run: ({ env, actor }, input) => mailserver.revokeMailboxAccess(env, actor, input.mailboxId, input.memberId),
})

export const emailOperations = [
  emailAddDomain,
  emailListDomains,
  emailGetDomain,
  emailGetDnsRecords,
  emailSetDomainEnabled,
  emailRemoveDomain,
  emailCreateMailbox,
  emailListMailboxes,
  emailGetMailbox,
  emailUpdateMailbox,
  emailSetMailboxPassword,
  emailDeleteMailbox,
  emailAddAlias,
  emailRemoveAlias,
  emailListAccess,
  emailGrantAccess,
  emailRevokeAccess,
]
