import { z } from 'zod'
import { acceptInvite, inviteMember, listMembers, lookupInvite, removeMember, resendInvite, setRole } from '../members/service'
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
  mcp: { readOnly: true },
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
  run: ({ env, actor }, { organizationId, ...input }) => inviteMember(env, actor, organizationId, input),
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
  description: "Changes a member's role to admin or member. Owners and admins only; the owner's role can't change.",
  input: z.object({ memberId: id, role }),
  http: { method: 'PATCH', path: '/members/:memberId' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ member: await setRole(env, actor, input.memberId, input.role) }),
})

export const membersRemove = defineOperation({
  name: 'members_remove',
  description:
    'Removes a member (or cancels an invite). Their own My Files are deleted with them. Someone who owns a personal mailbox has to have it removed first. Members can remove themselves to leave.',
  input: z.object({ memberId: id }),
  http: { method: 'DELETE', path: '/members/:memberId' },
  mcp: false,
  run: ({ env, actor }, input) => removeMember(env, actor, input.memberId),
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
  run: ({ env }, input) => acceptInvite(env, input),
})

export const memberOperations = [
  membersList,
  membersInvite,
  membersSendInvite,
  membersUpdate,
  membersRemove,
  invitationLookup,
  invitationAccept,
]
