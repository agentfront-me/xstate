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

export const emailCheckDomain = defineOperation({
  name: 'email_check_domain',
  description:
    'Check a domain before adding it: whether the name is valid, exists in public DNS, is already on xstate ' +
    '("taken"), and which provider hosts its DNS (e.g. Cloudflare), or null if unrecognized.',
  input: z.object({ name: z.string().trim().min(3).max(253) }),
  http: { method: 'GET', path: '/email/domain-check' },
  mcp: { readOnly: true },
  run: ({ env }, input) => mailserver.checkDomain(env, input.name),
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

export const emailVerifyDomain = defineOperation({
  name: 'email_verify_domain',
  description:
    'Look up the essential mail records (MX, SPF, DKIM, DMARC) in public DNS and report each as found or not. ' +
    'Marks the domain "verified" once every required record is found. Safe to call repeatedly while waiting.',
  input: z.object({ domainId: id }),
  http: { method: 'POST', path: '/email/domains/:domainId/verify' },
  run: ({ env, actor }, input) => mailserver.verifyDomain(env, actor, input.domainId),
})

export const emailDomainConnectUrl = defineOperation({
  name: 'email_domain_connect_url',
  description:
    "Get a one-click setup link (Domain Connect) that adds the domain's mail records at its DNS provider, e.g. " +
    'Cloudflare, after the owner signs in there and approves. Returns { applyUrl, provider }, with applyUrl null ' +
    'when the provider does not support it yet; then the records from email_verify_domain must be added by hand. ' +
    'redirectUri (optional, must be on an xstate app origin) is where the provider sends the browser back to.',
  input: z.object({ domainId: id, redirectUri: z.string().url().max(2048).optional() }),
  http: { method: 'GET', path: '/email/domains/:domainId/domain-connect' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => mailserver.domainConnectUrl(env, actor, input.domainId, input.redirectUri),
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
    'Create a mailbox on a domain. "personal" is one person\'s inbox; "shared" (e.g. hello@, support@) has no ' +
    'password and is opened by members you grant access to; "agent" is for an AI agent. personal and agent ' +
    'mailboxes get a generated password if none is given, returned once in the response.',
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

// Mail. Personal mailboxes can only be read by their owner; shared and agent mailboxes by the people allowed in.

const folderRole = z.enum(['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash'])
const truthy = z.union([z.boolean(), z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')])

export const emailListFolders = defineOperation({
  name: 'email_list_folders',
  description:
    'List the folders (Inbox, Sent, Drafts, Archive, Junk, Trash and custom ones) with unread and total counts, for ' +
    'one mailbox or every mailbox in the organization whose mail you can read.',
  input: z.object({ organizationId: id, mailboxId: id.optional() }),
  http: { method: 'GET', path: '/email/orgs/:organizationId/folders' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({
    mailboxes: await mailserver.listFolders(env, actor, input.organizationId, input.mailboxId),
  }),
})

export const emailListMessages = defineOperation({
  name: 'email_list_messages',
  description:
    'List the newest conversations in a folder, newest first, one row per conversation (its newest message there, ' +
    'with threadSize): one mailbox, or every mailbox you can read when mailboxId ' +
    'is omitted. folder is inbox, sent, drafts, archive, junk, trash or pinned (flagged anywhere but junk and ' +
    'trash). Filter with unreadOnly and a full-text query. Pass nextCursor back as cursor for the next page. ' +
    'Returns summaries with a preview; call email_get_thread for full bodies and attachments.',
  input: z.object({
    organizationId: id,
    mailboxId: id.optional(),
    folder: z.union([folderRole, z.literal('pinned')]).default('inbox'),
    unreadOnly: truthy.optional(),
    query: z.string().trim().max(200).optional(),
    cursor: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  http: { method: 'GET', path: '/email/orgs/:organizationId/messages' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => mailserver.listMessages(env, actor, input.organizationId, input),
})

export const emailGetThread = defineOperation({
  name: 'email_get_thread',
  description:
    'Get every message in a conversation, oldest first, with plain-text and HTML bodies and attachment details ' +
    '(blobId, name, type, size). Does not mark anything as read.',
  input: z.object({ mailboxId: id, threadId: z.string().min(1).max(64) }),
  http: { method: 'GET', path: '/email/mailboxes/:mailboxId/threads/:threadId' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({
    messages: await mailserver.getThread(env, actor, input.mailboxId, input.threadId),
  }),
})

export const emailUpdateMessage = defineOperation({
  name: 'email_update_message',
  description:
    'Change one message: mark it read or unread (seen), pin or unpin it (pinned, shown as flagged in mail apps), ' +
    'or move it to a folder (inbox, archive, junk, trash). With thread: true, seen and folder apply to the whole ' +
    'conversation (a move takes only its messages in the same folder as this one). Needs write access to the mailbox.',
  input: z
    .object({
      mailboxId: id,
      messageId: z.string().min(1).max(64),
      seen: z.boolean().optional(),
      pinned: z.boolean().optional(),
      folder: folderRole.optional(),
      thread: z.boolean().optional(),
    })
    .refine((v) => v.seen !== undefined || v.pinned !== undefined || v.folder !== undefined, 'Nothing to change'),
  http: { method: 'PATCH', path: '/email/mailboxes/:mailboxId/messages/:messageId' },
  run: ({ env, actor }, input) => mailserver.updateMessage(env, actor, input.mailboxId, input.messageId, input),
})

export const emailGetMailState = defineOperation({
  name: 'email_get_mail_state',
  description:
    'A token that changes whenever any message changes in a mailbox you can read. Poll it and reload when it differs.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/email/orgs/:organizationId/mail-state' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ state: await mailserver.getMailState(env, actor, input.organizationId) }),
})

export const emailGetAttachment = defineOperation({
  name: 'email_get_attachment',
  description: "Download an attachment's bytes, by the blobId, name and type from email_get_thread.",
  input: z.object({
    mailboxId: id,
    blobId: z.string().min(1).max(256),
    name: z.string().min(1).max(255).default('attachment'),
    type: z.string().min(1).max(255).default('application/octet-stream'),
  }),
  http: { method: 'GET', path: '/email/mailboxes/:mailboxId/attachments/:blobId' },
  mcp: false,
  run: ({ env, actor }, input) =>
    mailserver.getAttachment(env, actor, input.mailboxId, input.blobId, input.name, input.type),
})

const address = z.object({ email: z.email().max(254), name: z.string().trim().max(200).nullish() })
const addresses = z.array(address).max(50)

export const emailSend = defineOperation({
  name: 'email_send',
  description:
    "Send a message from a mailbox's address. Needs write access to the mailbox. For a reply pass inReplyTo (the " +
    "message id) so mail apps keep it in the same conversation; for a forward pass forwardOf, which brings the " +
    'original attachments along. attachments are blobs from the upload endpoint. The sent copy lands in Sent. ' +
    'At most 50 recipients in total.',
  input: z.object({
    mailboxId: id,
    to: addresses.default([]),
    cc: addresses.optional(),
    bcc: addresses.optional(),
    subject: z.string().max(998).default(''),
    text: z.string().max(1_000_000),
    html: z.string().max(2_000_000).optional(),
    inReplyTo: z.string().min(1).max(64).optional(),
    forwardOf: z.string().min(1).max(64).optional(),
    attachments: z
      .array(z.object({ blobId: z.string().min(1).max(256), name: z.string().min(1).max(255), type: z.string().min(1).max(255) }))
      .max(20)
      .optional(),
  }),
  http: { method: 'POST', path: '/email/mailboxes/:mailboxId/send', status: 201 },
  run: async ({ env, actor }, input) => ({
    message: await mailserver.sendMessage(env, actor, input.mailboxId, {
      ...input,
      to: input.to.map((a) => ({ email: a.email, name: a.name ?? null })),
      cc: input.cc?.map((a) => ({ email: a.email, name: a.name ?? null })),
      bcc: input.bcc?.map((a) => ({ email: a.email, name: a.name ?? null })),
    }),
  }),
})

export const emailOperations = [
  emailAddDomain,
  emailCheckDomain,
  emailListDomains,
  emailGetDomain,
  emailGetDnsRecords,
  emailVerifyDomain,
  emailDomainConnectUrl,
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
  emailListFolders,
  emailListMessages,
  emailGetThread,
  emailUpdateMessage,
  emailGetMailState,
  emailGetAttachment,
  emailSend,
]
