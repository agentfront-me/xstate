// Live updates for the apps. While the mobile app is on screen it keeps a WebSocket open here (one hub per
// organization), and the API says what changed: "mailbox X" after a mail sync, "agent Y" after a run or approval
// moves. Only ids, never content: the app reloads that list through the normal API, with its own access checks.
//
// Sockets use the hibernation API, so an idle connection costs nothing and the hub sleeps between events; the app's
// keep-alive "ping" is answered without waking it. Each socket is tagged with its user, so mail news goes only to the
// people who can open that mailbox. The Worker checks the token and membership before handing a socket over
// (live/route.ts); this class trusts its callers.

import { DurableObject } from 'cloudflare:workers'

export type LiveEvent = { type: 'mail'; mailboxId: string } | { type: 'agents'; agentId: string }

const userTag = (userId: string) => `user:${userId}`

export class LiveHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  /** A new socket for `?userId=`, already authenticated by the Worker. */
  override async fetch(request: Request): Promise<Response> {
    const userId = new URL(request.url).searchParams.get('userId')
    if (!userId || request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 })
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server, [userTag(userId)])
    return new Response(null, { status: 101, webSocket: client })
  }

  /** Sends the event to everyone connected, or only to `userIds`. Returns how many sockets got it. */
  async announce(event: LiveEvent, userIds?: string[]): Promise<number> {
    const sockets = userIds ? [...new Set(userIds)].flatMap((id) => this.ctx.getWebSockets(userTag(id))) : this.ctx.getWebSockets()
    const text = JSON.stringify(event)
    let sent = 0
    for (const ws of sockets) {
      try {
        ws.send(text)
        sent++
      } catch {
        // Closing already; the app reconnects.
      }
    }
    return sent
  }

  override async webSocketMessage(): Promise<void> {
    // The apps only send "ping", answered above without waking the hub.
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed')
    } catch {
      // Already closed.
    }
  }
}
