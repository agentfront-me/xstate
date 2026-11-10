// Push notifications to the mobile app, through Expo's push service (which forwards to Apple and Google).
//
// Anything that wants to tell people something calls push(): it only puts a job on the PUSH queue, so mail sync and
// agent runs never wait on Expo. The consumer looks up the phones, sends, and 15 minutes later asks Expo for the
// receipts: that is where it says a token is dead, and those phones are removed.
// https://docs.expo.dev/push-notifications/sending-notifications/

import * as devices from '../db/devices'
import type { PushKind } from '../db/devices'

const EXPO = 'https://exp.host/--/api/v2/push'

export type PushMessage = {
  /** Which Settings switch covers it. */
  kind: PushKind
  userIds: string[]
  title: string
  body: string
  /** Where a tap goes, as a path in the app: "/thread?mailboxId=…", "/agent/<id>". */
  path: string
  /** New mail: the mailbox's domain, for phones narrowed to one domain. */
  domainId?: string
}

export type PushJob = ({ type: 'send' } & PushMessage) | { type: 'receipts'; tokens: Record<string, string> }

/** Queues a notification. Best effort: a failure is logged and never stops the caller. */
export async function push(env: Pick<Env, 'PUSH'>, message: PushMessage): Promise<void> {
  if (!message.userIds.length) return
  await env.PUSH.send({ type: 'send', ...message }).catch((err) => console.error('push enqueue failed', err))
}

type Ticket = { status: 'ok'; id: string } | { status: 'error'; message?: string; details?: { error?: string } }
type Receipt = { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } }

async function expo<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${EXPO}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`Expo push ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`)
  return ((await response.json()) as { data: T }).data
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

async function send(env: Env, job: PushMessage): Promise<void> {
  const phones = await devices.forUsers(env.DB, job.userIds, job.kind, job.domainId)
  if (!phones.length) return
  const dead: string[] = []
  const sent: Record<string, string> = {}
  // Expo takes up to 100 messages a request and answers with one ticket per message, in order.
  for (let i = 0; i < phones.length; i += 100) {
    const chunk = phones.slice(i, i + 100)
    const tickets = await expo<Ticket[]>(
      'send',
      chunk.map((d) => ({ to: d.token, title: clip(job.title, 80), body: clip(job.body, 160), sound: 'default', channelId: 'default', data: { path: job.path, kind: job.kind } })),
    )
    tickets.forEach((ticket, n) => {
      const token = chunk[n]!.token
      if (ticket.status === 'ok') sent[ticket.id] = token
      else if (ticket.details?.error === 'DeviceNotRegistered') dead.push(token)
      else console.error('push refused', JSON.stringify({ error: ticket.details?.error, message: ticket.message }))
    })
  }
  if (dead.length) await devices.removeTokens(env.DB, dead)
  if (Object.keys(sent).length) await env.PUSH.send({ type: 'receipts', tokens: sent }, { delaySeconds: 900 })
}

async function receipts(env: Env, tokens: Record<string, string>): Promise<void> {
  const result = await expo<Record<string, Receipt>>('getReceipts', { ids: Object.keys(tokens) })
  const dead = Object.entries(result)
    .filter(([, r]) => r.status === 'error' && r.details?.error === 'DeviceNotRegistered')
    .map(([id]) => tokens[id])
    .filter((t): t is string => !!t)
  if (dead.length) await devices.removeTokens(env.DB, dead)
}

/** Queue consumer. */
export async function consumePush(batch: MessageBatch<PushJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (message.body.type === 'send') await send(env, message.body)
      else await receipts(env, message.body.tokens)
      message.ack()
    } catch (err) {
      console.error('push failed', err)
      message.retry({ delaySeconds: 30 * message.attempts })
    }
  }
}
