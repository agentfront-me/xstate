// Storage: the organization's folders and files, and the read-only Mail Attachments folder. Uploading a file and
// saving new contents take the file as the request body, so they're plain routes (http/storage-uploads.ts).

import { z } from 'zod'
import * as drive from '../storage/drive'
import { defineOperation } from './define'

const id = z.string().min(1).max(64)
const space = z.enum(['personal', 'organization'])
const role = z.enum(['viewer', 'editor', 'manager'])
const orgAccess = z.enum(['viewer', 'editor'])
const name = z.string().trim().min(1).max(180)
const version = z.coerce.number().int().min(1)

export const storageListTop = defineOperation({
  name: 'storage_list',
  description:
    'List the top of a Storage view. view: "personal" (My Files), "organization" (team folders you can see), ' +
    '"shared" (items others shared with you) or "trash". Items have id, kind (folder/file), name, size, version ' +
    'and your role (viewer, editor or manager). Open a folder with storage_get_folder.',
  input: z.object({ organizationId: id, view: z.enum(['personal', 'organization', 'shared', 'trash']).default('personal') }),
  http: { method: 'GET', path: '/storage/orgs/:organizationId/items' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({ items: await drive.listTop(env, actor, input.organizationId, input.view) }),
})

export const storageGetFolder = defineOperation({
  name: 'storage_get_folder',
  description: "List a folder's contents (folders first), with the folder itself and the path to it.",
  input: z.object({ folderId: id }),
  http: { method: 'GET', path: '/storage/folders/:folderId' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => drive.getFolder(env, actor, input.folderId),
})

export const storageGetItem = defineOperation({
  name: 'storage_get_item',
  description: 'Get one file or folder: name, type, size, current version, owner, your role, and the path to it.',
  input: z.object({ itemId: id }),
  http: { method: 'GET', path: '/storage/items/:itemId' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => drive.getItem(env, actor, input.itemId),
})

export const storageCreateFolder = defineOperation({
  name: 'storage_create_folder',
  description:
    'Create a folder inside parentId, or at the top of a space when parentId is left out: "personal" (My Files, ' +
    'private to you) or "organization" (a team folder everyone in the organization can view until you change it).',
  input: z.object({ organizationId: id, name, parentId: id.optional(), space: space.optional() }),
  http: { method: 'POST', path: '/storage/orgs/:organizationId/folders', status: 201 },
  run: async ({ env, actor }, { organizationId, ...input }) => ({
    item: await drive.createFolder(env, actor, organizationId, input),
  }),
})

export const storageUpdateItem = defineOperation({
  name: 'storage_update_item',
  description:
    'Rename a file or folder, or move it: parentId moves it into that folder; parentId null with space moves it ' +
    'to the top of My Files ("personal") or the team folders ("organization"). Needs editor access on both sides.',
  input: z.object({ itemId: id, name: name.optional(), parentId: id.nullable().optional(), space: space.optional() }),
  http: { method: 'PATCH', path: '/storage/items/:itemId' },
  run: async ({ env, actor }, { itemId, ...input }) => ({ item: await drive.updateItem(env, actor, itemId, input) }),
})

export const storageTrashItem = defineOperation({
  name: 'storage_trash_item',
  description: 'Move a file or folder (with everything inside) to the trash. It can be restored for 30 days.',
  input: z.object({ itemId: id }),
  http: { method: 'POST', path: '/storage/items/:itemId/trash' },
  mcp: { destructive: true },
  run: ({ env, actor }, input) => drive.trashItem(env, actor, input.itemId),
})

export const storageRestoreItem = defineOperation({
  name: 'storage_restore_item',
  description: 'Take a file or folder out of the trash, back where it was.',
  input: z.object({ itemId: id }),
  http: { method: 'POST', path: '/storage/items/:itemId/restore' },
  run: async ({ env, actor }, input) => ({ item: await drive.restoreItem(env, actor, input.itemId) }),
})

export const storageDeleteItem = defineOperation({
  name: 'storage_delete_item',
  description: 'Delete a trashed file or folder for good, with everything inside it. Managers only. Cannot be undone.',
  input: z.object({ itemId: id }),
  http: { method: 'DELETE', path: '/storage/items/:itemId' },
  mcp: { destructive: true },
  run: ({ env, actor }, input) => drive.deleteItem(env, actor, input.itemId),
})

export const storageReadContent = defineOperation({
  name: 'storage_read_content',
  description: "A file's bytes (the current version, or an earlier one).",
  input: z.object({ itemId: id, version: version.optional() }),
  http: { method: 'GET', path: '/storage/items/:itemId/content' },
  mcp: false,
  run: ({ env, actor }, input) => drive.readContent(env, actor, input.itemId, input.version),
})

export const storageDownloadUrl = defineOperation({
  name: 'storage_download_url',
  description: 'A link that downloads the file (or an earlier version) for the next 5 minutes.',
  input: z.object({ itemId: id, version: version.optional() }),
  http: { method: 'GET', path: '/storage/items/:itemId/download' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => drive.downloadUrl(env, actor, input.itemId, input.version),
})

export const storageReadText = defineOperation({
  name: 'storage_read_text',
  description: 'Read a text file (CSV, Markdown, plain text, JSON) up to 1 MB. Returns the item (with its version) and text.',
  input: z.object({ itemId: id }),
  http: { method: 'GET', path: '/storage/items/:itemId/text' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => drive.readText(env, actor, input.itemId),
})

export const storageWriteText = defineOperation({
  name: 'storage_write_text',
  description:
    'Replace a text file\'s contents, saved as a new version. baseVersion is the version you read: if someone ' +
    'saved since, this fails with version_conflict; read it again and retry.',
  input: z.object({ itemId: id, baseVersion: version, text: z.string().max(1024 * 1024) }),
  http: { method: 'PUT', path: '/storage/items/:itemId/text' },
  run: async ({ env, actor }, input) => ({
    item: await drive.writeText(env, actor, input.itemId, input.baseVersion, input.text),
  }),
})

export const storageCreateTextFile = defineOperation({
  name: 'storage_create_text_file',
  description:
    'Create a text file (e.g. notes.md or data.csv) with the given contents, inside parentId or at the top of a ' +
    'space. A name already used there gets a number.',
  input: z.object({
    organizationId: id,
    name,
    text: z.string().max(1024 * 1024),
    parentId: id.optional(),
    space: space.optional(),
  }),
  http: { method: 'POST', path: '/storage/orgs/:organizationId/text-files', status: 201 },
  run: async ({ env, actor }, { organizationId, name, text, ...where }) => ({
    item: await drive.uploadFile(env, actor, organizationId, where, {
      name,
      contentType: 'text/plain',
      size: new TextEncoder().encode(text).byteLength,
      body: text,
    }),
  }),
})

export const storageListVersions = defineOperation({
  name: 'storage_list_versions',
  description: 'A file\'s current version and the earlier ones still kept (the last 5, each for 30 days).',
  input: z.object({ itemId: id }),
  http: { method: 'GET', path: '/storage/items/:itemId/versions' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => drive.listVersions(env, actor, input.itemId),
})

export const storageRestoreVersion = defineOperation({
  name: 'storage_restore_version',
  description: 'Make an earlier version current again. It is saved as a new version, so nothing is lost.',
  input: z.object({ itemId: id, version }),
  http: { method: 'POST', path: '/storage/items/:itemId/versions/:version/restore' },
  run: async ({ env, actor }, input) => ({ item: await drive.restoreVersion(env, actor, input.itemId, input.version) }),
})

export const storageListAccess = defineOperation({
  name: 'storage_list_access',
  description:
    'Who can open a file or folder: its owner, what everyone in the organization gets, people it is shared with, ' +
    'and what comes from folders above it.',
  input: z.object({ itemId: id }),
  http: { method: 'GET', path: '/storage/items/:itemId/access' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => drive.listAccess(env, actor, input.itemId),
})

export const storageSetAccess = defineOperation({
  name: 'storage_set_access',
  description:
    'Share a file or folder (managers only). orgAccess: what everyone in the organization gets (null for nobody ' +
    'beyond the people listed). grants: members to add or change (role viewer, editor or manager) or remove ' +
    '(role null). Access on a folder applies to everything inside it.',
  input: z.object({
    itemId: id,
    orgAccess: orgAccess.nullable().optional(),
    grants: z.array(z.object({ memberId: id, role: role.nullable() })).max(100).optional(),
  }),
  http: { method: 'PUT', path: '/storage/items/:itemId/access' },
  run: ({ env, actor }, { itemId, ...input }) => drive.setAccess(env, actor, itemId, input),
})

export const storageSetPublicLink = defineOperation({
  name: 'storage_set_public_link',
  description:
    'Turn the public link of a file or folder on or off (managers only). Anyone with the link can view and ' +
    'download it, and everything inside a folder, without signing in. Turning it off and on again makes a new link.',
  input: z.object({ itemId: id, enabled: z.boolean() }),
  http: { method: 'PUT', path: '/storage/items/:itemId/public-link' },
  // Not for agents: a link puts the file on the open internet, which only a person should decide.
  mcp: false,
  run: ({ env, actor }, { itemId, enabled }) => drive.setAccess(env, actor, itemId, { publicLink: enabled }),
})

const token = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)

export const storagePublicView = defineOperation({
  name: 'storage_public_view',
  description: 'What a public link shows: the linked item and, for a folder, its contents. No sign-in.',
  input: z.object({ token, folderId: id.optional() }),
  public: true,
  http: { method: 'GET', path: '/public/storage/:token' },
  mcp: false,
  run: ({ env }, { token, folderId }) => drive.publicView(env, token, folderId),
})

export const storagePublicContent = defineOperation({
  name: 'storage_public_content',
  description: "A file's bytes through a public link (the linked file, or a file inside the linked folder).",
  input: z.object({ token, itemId: id.optional() }),
  public: true,
  http: { method: 'GET', path: '/public/storage/:token/content' },
  mcp: false,
  run: ({ env }, { token, itemId }) => drive.publicContent(env, token, itemId),
})

export const storageGetUsage = defineOperation({
  name: 'storage_get_usage',
  description:
    'Size and file count of your My Files, the team folders and the mail attachments you can read, and how many ' +
    'items are in your trash.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/storage/orgs/:organizationId/usage' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => drive.getUsage(env, actor, input.organizationId),
})

export const storageListMembers = defineOperation({
  name: 'storage_list_members',
  description: 'People in the organization, with their member id, to share files with.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/storage/orgs/:organizationId/members' },
  mcp: { readOnly: true },
  run: async ({ env, actor }, input) => ({ members: await drive.listMembers(env, actor, input.organizationId) }),
})

// Mail Attachments

export const storageListAttachments = defineOperation({
  name: 'storage_list_attachments',
  description:
    'Attachments of the mail you can read, newest first, optionally for one mailbox, only "received" or "sent", or ' +
    'matching a name. Also lists the mailboxes with how many attachments each has. Page with nextCursor.',
  input: z.object({
    organizationId: id,
    mailboxId: id.optional(),
    source: z.enum(['received', 'sent']).optional(),
    query: z.string().max(200).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  http: { method: 'GET', path: '/storage/orgs/:organizationId/attachments' },
  mcp: { readOnly: true },
  run: ({ env, actor }, { organizationId, ...input }) => drive.listAttachments(env, actor, organizationId, input),
})

export const storageGetAttachment = defineOperation({
  name: 'storage_get_attachment',
  description: 'Get one mail attachment: name, type, size, received or sent, its message and thread, and the mailbox.',
  input: z.object({ fileId: id }),
  http: { method: 'GET', path: '/storage/attachments/:fileId' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => drive.getAttachment(env, actor, input.fileId),
})

export const storageAttachmentContent = defineOperation({
  name: 'storage_attachment_content',
  description: "A mail attachment's bytes.",
  input: z.object({ fileId: id }),
  http: { method: 'GET', path: '/storage/attachments/:fileId/content' },
  mcp: false,
  run: ({ env, actor }, input) => drive.attachmentContent(env, actor, input.fileId),
})

export const storageAttachmentDownloadUrl = defineOperation({
  name: 'storage_attachment_download_url',
  description: 'A link that downloads a mail attachment for the next 5 minutes.',
  input: z.object({ fileId: id }),
  http: { method: 'GET', path: '/storage/attachments/:fileId/download' },
  mcp: { readOnly: true },
  run: ({ env, actor }, input) => drive.attachmentDownloadUrl(env, actor, input.fileId),
})

export const storageSaveAttachment = defineOperation({
  name: 'storage_save_attachment',
  description:
    'Copy a mail attachment into Storage so it can be edited and shared: into parentId, or the top of My Files.',
  input: z.object({ fileId: id, parentId: id.optional(), space: space.optional() }),
  http: { method: 'POST', path: '/storage/attachments/:fileId/save', status: 201 },
  run: async ({ env, actor }, { fileId, ...where }) => ({ item: await drive.saveAttachment(env, actor, fileId, where) }),
})

export const storageOperations = [
  storageListTop,
  storageGetFolder,
  storageGetItem,
  storageCreateFolder,
  storageUpdateItem,
  storageTrashItem,
  storageRestoreItem,
  storageDeleteItem,
  storageReadContent,
  storageDownloadUrl,
  storageReadText,
  storageWriteText,
  storageCreateTextFile,
  storageListVersions,
  storageRestoreVersion,
  storageListAccess,
  storageSetAccess,
  storageSetPublicLink,
  storagePublicView,
  storagePublicContent,
  storageGetUsage,
  storageListMembers,
  storageListAttachments,
  storageGetAttachment,
  storageAttachmentContent,
  storageAttachmentDownloadUrl,
  storageSaveAttachment,
]
