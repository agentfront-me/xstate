// GET /v1/live/orgs/:organizationId: opens the live-updates WebSocket (live/hub.ts) for a member of the
// organization. Sent with `Authorization: Bearer <token>` like every other call (the mobile app's WebSocket can set
// headers). A token that expires later doesn't close the socket: it only ever carries ids.

import type { Context } from 'hono'
import { verifyToken } from '../auth/token'
import * as membersDb from '../db/members'
import { ApiError } from '../errors'
import type { AppEnv } from '../http/types'

export async function handleLive(c: Context<AppEnv>): Promise<Response> {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') throw new ApiError('upgrade_required', 'Open this as a WebSocket', 400)
  const token = c.req.header('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token) throw new ApiError('unauthenticated', 'Send Authorization: Bearer <token>', 401)
  const { userId } = await verifyToken(c.env, token)
  const organizationId = c.req.param('organizationId')!
  if (!(await membersDb.find(c.env.DB, organizationId, userId))) throw new ApiError('not_found', 'No such organization', 404)

  const hub = c.env.LIVE.get(c.env.LIVE.idFromName(organizationId))
  return hub.fetch(new Request(`https://live/?userId=${encodeURIComponent(userId)}`, { headers: { Upgrade: 'websocket' } }))
}
