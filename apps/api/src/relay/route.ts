// GET /relay/imap and /relay/smtp: where the mail bridge (services/mail-bridge, on deepo) hands over a mail app's
// connection as a WebSocket (docs/imap-smtp-relay-plan.md, 3.1 and 3.3). Only the bridge may call these: it sends the
// secret RELAY_SECRET, and without that secret set the routes don't exist. Each connection gets its own session
// object, which speaks the protocol and holds the socket through hibernation.

import type { Context } from 'hono'
import type { AppEnv } from '../http/types'

type RelayEnv = { RELAY_SECRET?: string }

const notFound = (c: Context<AppEnv>) => c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404)

/** True when `given` is the bridge's secret. Both sides are hashed first, so the comparison takes the same time. */
export async function isBridge(env: RelayEnv, given: string | undefined): Promise<boolean> {
  if (!env.RELAY_SECRET || !given) return false
  const digest = (text: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const [a, b] = await Promise.all([digest(given), digest(env.RELAY_SECRET)])
  return crypto.subtle.timingSafeEqual(a, b)
}

export async function handleRelay(c: Context<AppEnv>): Promise<Response> {
  if (!(await isBridge(c.env as RelayEnv, c.req.header('X-Relay-Secret')))) return notFound(c)
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: { code: 'upgrade_required', message: 'Open this as a WebSocket' } }, 426)
  const protocol = c.req.param('protocol')
  if (protocol !== 'imap' && protocol !== 'smtp') return notFound(c)
  const sessions = protocol === 'imap' ? c.env.IMAP_SESSION : c.env.SMTP_SESSION
  const session = sessions.get(sessions.newUniqueId())
  const query = new URLSearchParams({ ip: c.req.header('X-Client-IP') ?? '', tls: c.req.query('tls') ?? 'implicit' })
  return session.fetch(new Request(`https://relay/?${query}`, { headers: { Upgrade: 'websocket' } }))
}

/** POST /relay/poke/:id (testing only, bridge secret needed): tells one session its mailbox changed, as the store does. */
export async function handleRelayPoke(c: Context<AppEnv>): Promise<Response> {
  if (!(await isBridge(c.env as RelayEnv, c.req.header('X-Relay-Secret')))) return notFound(c)
  return c.json({ told: await c.env.IMAP_SESSION.get(c.env.IMAP_SESSION.idFromString(c.req.param('id')!)).changed() })
}
