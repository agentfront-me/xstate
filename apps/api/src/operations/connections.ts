// Connecting an AI app over MCP: the consent page's calls (mcp/consent.ts), and Settings → Apps and API
// (mcp/connections.ts). All off MCP: an app can't approve itself, see other connections or disconnect them.

import { z } from 'zod'
import { listConnections, revokeConnection } from '../mcp/connections'
import { approveRequest, denyRequest, describeRequest } from '../mcp/consent'
import { defineOperation } from './define'

const id = z.string().min(1).max(64)
const requestId = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Not a sign-in request')
const level = z.enum(['off', 'read', 'write'])

export const connectGetRequest = defineOperation({
  name: 'connect_get_request',
  description:
    'An app’s waiting request to connect: its name, its verified domain (null when it only claims the name), where ' +
    'access would be sent, and for each of your organizations the mailboxes you could let it use.',
  input: z.object({ requestId }),
  http: { method: 'GET', path: '/connect/requests/:requestId' },
  mcp: false,
  run: ({ env, actor }, input) => describeRequest(env, actor, input.requestId),
})

export const connectApprove = defineOperation({
  name: 'connect_approve',
  description:
    'Let the app connect to one organization with the chosen mailboxes and access. Returns redirectTo, the address ' +
    'that takes the browser back to the app. A request can be answered once.',
  input: z.object({
    requestId,
    organizationId: id,
    mailboxIds: z.array(id).max(200),
    email: z.enum(['read', 'draft', 'send']),
    calendar: level,
    storage: level,
    contacts: level,
    setup: z.boolean().default(false),
  }),
  http: { method: 'POST', path: '/connect/requests/:requestId/approve' },
  mcp: false,
  run: ({ env, actor, waitUntil }, { requestId: request, ...input }) => approveRequest(env, actor, request, input, waitUntil),
})

export const connectDeny = defineOperation({
  name: 'connect_deny',
  description: 'Decline an app’s request to connect. Returns redirectTo, the address that tells the app.',
  input: z.object({ requestId }),
  http: { method: 'POST', path: '/connect/requests/:requestId/deny' },
  mcp: false,
  run: ({ env }, input) => denyRequest(env, input.requestId),
})

export const connectionsList = defineOperation({
  name: 'connections_list',
  description:
    'AI apps connected to the organization over MCP: the app, who connected it, what it may do (scopes), its ' +
    'mailboxes, when it was connected and last active. Yours; owners and admins see everyone’s.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/orgs/:organizationId/connections' },
  mcp: false,
  run: ({ env, actor }, input) => listConnections(env, actor, input.organizationId),
})

export const connectionsRevoke = defineOperation({
  name: 'connections_revoke',
  description: 'Disconnect an app: its access ends at once. Your own connections; owners and admins can disconnect anyone’s.',
  input: z.object({ organizationId: id, connectionId: z.string().min(1).max(128) }),
  http: { method: 'DELETE', path: '/orgs/:organizationId/connections/:connectionId' },
  mcp: false,
  run: ({ env, actor }, input) => revokeConnection(env, actor, input.organizationId, input.connectionId),
})

export const connectionOperations = [connectGetRequest, connectApprove, connectDeny, connectionsList, connectionsRevoke]
