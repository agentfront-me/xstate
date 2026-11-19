import { z } from 'zod'
import { syncSeats } from '../billing/service'
import { completeReset, lookupReset, sendResetLink, setTemporaryPassword } from '../members/passwords'
import { deleteMember } from '../members/deletion'
import { restoreMember, signOutEverywhere, suspendMember } from '../members/security'
import {
  acceptInvite,
  addMember,
  inviteMember,
  listMembers,
  lookupInvite,
  removeMember,
  resendInvite,
  setPrimaryAddress,
  setRole,
  updateMember,
} from '../members/service'
import { track, userHash } from '../analytics/events'
import { ApiError } from '../errors'
import { defineOperation } from './define'

const id = z.string().min(1).max(64)
const role = z.enum(['admin', 'member'])
const token = z.string().min(20).max(100)

export const membersList = defineOperation({
  name: 'members_list',
  description:
    'Everyone in the organization: name, email, role (owner, admin or member) and status (invited or active). Invited members include when their invite was sent and when it expires.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/members/orgs/:organizationId' },
  mcp: { scope: 'profile', readOnly: true },
  run: async ({ env, actor }, input) => ({ members: await listMembers(env, actor, input.organizationId) }),
})

export const membersInvite = defineOperation({
  name: 'members_invite',
  description:
    'Invites someone to the organization by email, as a member or admin. They join as "invited" and get an email with a link to accept; someone new to xstate sets a password there. Set send to false to create the invite without emailing it yet (members_send_invite sends it later).',
  input: z.object({
    organizationId: id,
    email: z.email().max(254),
    name: z.string().trim().min(1).max(100).optional(),
    role: role.default('member'),
    send: z.boolean().default(true),
  }),
  http: { method: 'POST', path: '/members/orgs/:organizationId', status: 201 },
  mcp: false,
  run: async ({ env, actor, waitUntil }, { organizationId, ...input }) => {
    const result = await inviteMember(env, actor, organizationId, input)
    if (input.send) track(env, waitUntil, actor.userId, organizationId, 'Member Invited', { role: input.role })
    return result
  },
})

const address = z.object({ localPart: z.string().trim().min(1).max(64), domainId: id })

export const membersAdd = defineOperation({
  name: 'members_add',
  description:
    'Adds someone with their own mailbox. They sign in with its primary address. alsoAt adds more addresses (on any of the organization\'s domains) that deliver to the same mailbox. signIn "invite" emails a link to recoveryEmail so they choose a password; "password" returns a temporary password once, which they must change when they first sign in.',
  input: z.object({
    organizationId: id,
    name: z.string().trim().min(1).max(100),
    role: role.default('member'),
    mailbox: address,
    alsoAt: z.array(address).max(10).default([]),
    signIn: z.enum(['invite', 'password']),
    recoveryEmail: z.email().max(254).optional(),
  }),
  http: { method: 'POST', path: '/members/orgs/:organizationId/add', status: 201 },
  mcp: false,
  run: async ({ env, actor, waitUntil }, { organizationId, ...input }) => {
    const result = await addMember(env, actor, organizationId, input)
    // A personal mailbox is a seat.
    waitUntil(syncSeats(env, organizationId))
    return result
  },
})

export const membersSetPrimaryAddress = defineOperation({
  name: 'members_set_primary_address',
  description:
    "Makes another of a member's addresses their primary one, which is also what they sign in with. Only for mailboxes on xstate's new mail system.",
  input: z.object({ memberId: id, addressId: id }),
  http: { method: 'POST', path: '/members/:memberId/addresses/:addressId/primary' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ member: await setPrimaryAddress(env, actor, input.memberId, input.addressId) }),
})

export const membersSendInvite = defineOperation({
  name: 'members_send_invite',
  description: 'Sends an invited member their invite email again, with a new link. The previous link stops working.',
  input: z.object({ memberId: id }),
  http: { method: 'POST', path: '/members/:memberId/invite' },
  mcp: false,
  run: ({ env, actor }, input) => resendInvite(env, actor, input.memberId),
})

export const membersUpdate = defineOperation({
  name: 'members_update',
  description:
    "Changes a member's role (owners and admins only; the owner's role can't change), name or recovery email (the address their invites and reset links go to). Members can change their own name and recovery email.",
  input: z.object({
    memberId: id,
    role: role.optional(),
    name: z.string().trim().min(1).max(100).optional(),
    recoveryEmail: z.union([z.email().max(254), z.literal(''), z.null()]).optional(),
  }),
  http: { method: 'PATCH', path: '/members/:memberId' },
  mcp: false,
  run: async ({ env, actor }, { memberId, role, ...details }) => {
    let member = role ? await setRole(env, actor, memberId, role) : undefined
    if (details.name !== undefined || details.recoveryEmail !== undefined) {
      member = await updateMember(env, actor, memberId, { name: details.name, recoveryEmail: details.recoveryEmail || null })
    }
    if (!member) throw new ApiError('nothing_to_change', 'Nothing to change')
    return { member }
  },
})

export const membersRemove = defineOperation({
  name: 'members_remove',
  description:
    'Removes a member (or cancels an invite). Their own My Files are deleted with them. Someone who owns a personal mailbox has to have it removed first. Members can remove themselves to leave.',
  input: z.object({ memberId: id }),
  http: { method: 'DELETE', path: '/members/:memberId' },
  mcp: false,
  run: ({ env, actor, waitUntil }, input) => removeMember(env, actor, input.memberId, waitUntil),
})

export const membersSetPassword = defineOperation({
  name: 'members_set_password',
  description:
    "Gives a member a new temporary password, returned once. They must choose their own at their next sign-in. Only for members who sign in with an address of the organization's own; never the owner, and only the owner for an admin.",
  input: z.object({ memberId: id }),
  http: { method: 'POST', path: '/members/:memberId/password' },
  mcp: false,
  run: ({ env, actor }, input) => setTemporaryPassword(env, actor, input.memberId),
})

export const membersSendReset = defineOperation({
  name: 'members_send_password_reset',
  description: 'Emails a member a link to choose a new password (to their secondary email when they sign in with an organization address). It works for 24 hours.',
  input: z.object({ memberId: id }),
  http: { method: 'POST', path: '/members/:memberId/password-reset' },
  mcp: false,
  run: ({ env, actor }, input) => sendResetLink(env, actor, input.memberId),
})

export const membersSignOut = defineOperation({
  name: 'members_sign_out_everywhere',
  description: 'Signs a member out of xstate on every device, and stops alerts on their phones until they sign in again.',
  input: z.object({ memberId: id }),
  http: { method: 'POST', path: '/members/:memberId/sign-out' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ member: await signOutEverywhere(env, actor, input.memberId) }),
})

export const membersSuspend = defineOperation({
  name: 'members_suspend',
  description:
    "Suspends a member: they're signed out and can't sign in to the organization or reach anything in it, through the app, API tokens or connected AI apps. Their mailbox keeps receiving mail. members_restore undoes it.",
  input: z.object({ memberId: id }),
  http: { method: 'POST', path: '/members/:memberId/suspend' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ member: await suspendMember(env, actor, input.memberId) }),
})

export const membersRestore = defineOperation({
  name: 'members_restore',
  description: 'Gives a suspended member their access back.',
  input: z.object({ memberId: id }),
  http: { method: 'POST', path: '/members/:memberId/restore' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ member: await restoreMember(env, actor, input.memberId) }),
})

export const membersDelete = defineOperation({
  name: 'members_delete',
  description:
    'Deletes a member, restorable for 30 days (members_restore). They are suspended at once and their agents paused. mail "shared": the members in shareWith can open their mailbox now, and it becomes a shared mailbox when the deletion finishes. mail "delete": the mailbox and its mail are deleted then. Their My Files go to whoever deleted them.',
  input: z.object({ memberId: id, mail: z.enum(['shared', 'delete']), shareWith: z.array(id).max(50).default([]) }),
  http: { method: 'POST', path: '/members/:memberId/delete' },
  mcp: false,
  run: async ({ env, actor }, { memberId, ...input }) => ({ member: await deleteMember(env, actor, memberId, input) }),
})

export const passwordResetLookup = defineOperation({
  name: 'auth_password_reset_lookup',
  description: 'Which account a password reset link is for.',
  input: z.object({ token }),
  public: true,
  http: { method: 'POST', path: '/auth/password-reset/lookup' },
  mcp: false,
  run: async ({ env }, input) => ({ reset: await lookupReset(env, input.token) }),
})

export const passwordResetComplete = defineOperation({
  name: 'auth_password_reset_complete',
  description: 'Sets a new password from a reset link and returns a session token. The link works once.',
  input: z.object({ token, password: z.string().min(8, 'Password must be at least 8 characters').max(256) }),
  public: true,
  http: { method: 'POST', path: '/auth/password-reset/complete' },
  mcp: false,
  run: ({ env }, input) => completeReset(env, input),
})

// Public: the token from the invite link is the credential. POST, so the token never appears in a URL or log.

export const invitationLookup = defineOperation({
  name: 'auth_invitation_lookup',
  description: 'What an invite link is for: the organization, who sent it, the email it was sent to and whether a password is needed.',
  input: z.object({ token }),
  public: true,
  http: { method: 'POST', path: '/auth/invitations/lookup' },
  mcp: false,
  run: async ({ env }, input) => ({ invite: await lookupInvite(env, input.token) }),
})

export const invitationAccept = defineOperation({
  name: 'auth_invitation_accept',
  description:
    'Accepts an invite. Someone new to xstate gives a name and password and gets a session token. Someone with an account joins and then signs in as usual (signIn: true).',
  input: z.object({
    token,
    name: z.string().trim().min(1).max(100).optional(),
    password: z.string().min(8, 'Password must be at least 8 characters').max(256).optional(),
  }),
  public: true,
  http: { method: 'POST', path: '/auth/invitations/accept' },
  mcp: false,
  run: async ({ env, waitUntil }, input) => {
    const result = await acceptInvite(env, input, waitUntil)
    return result.signIn ? result : { ...result, userHash: await userHash(env, result.user.id) }
  },
})

export const memberOperations = [
  membersList,
  membersInvite,
  membersAdd,
  membersSetPrimaryAddress,
  membersSendInvite,
  membersUpdate,
  membersRemove,
  membersSetPassword,
  membersSendReset,
  membersSignOut,
  membersSuspend,
  membersRestore,
  membersDelete,
  invitationLookup,
  invitationAccept,
  passwordResetLookup,
  passwordResetComplete,
]
