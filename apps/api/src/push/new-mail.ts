// "New email" notifications. Rides on mail sync like agents' email triggers do: whenever a mailbox is synced
// (Stalwart's webhook on new mail, and the hourly safety check) this looks at what arrived since its own saved JMAP
// state and tells the people who can open the mailbox.
//
// What does not notify: agents' mailboxes, mail that isn't in the inbox or is already read, mail the mailbox sent
// itself, and anything received more than half an hour ago (an import copies years of old mail through the same
// webhook). More than three at once become one "5 new emails" notification.

import * as devices from '../db/devices'
import * as accessDb from '../db/mailbox-access'
import * as mailboxesDb from '../db/mailboxes'
import * as jmap from '../mailserver/stalwart/mail'
import { push } from './send'

const FRESH_MS = 30 * 60_000
const MAX_EACH = 3

export async function notifyNewMail(env: Env, mailboxId: string): Promise<{ notified: number }> {
  const none = { notified: 0 }
  const mailbox = await mailboxesDb.find(env.DB, mailboxId)
  if (!mailbox || mailbox.kind === 'agent') return none
  const userIds = (await accessDb.list(env.DB, mailboxId)).map((a) => a.user_id)
  // Nobody with the app and the switch on: nothing to ask Stalwart for. The saved state is cleared, so the first
  // sync after someone installs the app starts from then, not from mail that arrived before.
  const key = `mail:${mailboxId}`
  const saved = await devices.getState(env.DB, key)
  if (!(await devices.forUsers(env.DB, userIds, 'email', mailbox.domain_id)).length) {
    if (saved) await devices.setState(env.DB, key, '')
    return none
  }

  const accountId = mailbox.stalwart_id
  const current = (await jmap.getEmailStates(env, [accountId])).get(accountId) ?? ''
  if (!saved) {
    await devices.setState(env.DB, key, current)
    return none
  }
  if (saved === current) return none

  const created: string[] = []
  let state = saved
  for (let i = 0; i < 5; i++) {
    const changes = await jmap.emailChanges(env, accountId, state, 200)
    // Too old to diff from: start over from now.
    if (!changes) {
      await devices.setState(env.DB, key, current)
      return none
    }
    created.push(...changes.created)
    state = changes.newState
    if (!changes.hasMoreChanges) break
  }
  // Saved before sending: a crash here skips a notification rather than sending it twice.
  await devices.setState(env.DB, key, state)
  if (!created.length) return none

  const inbox = ((await jmap.getFolders(env, [accountId])).get(accountId) ?? []).find((f) => f.role === 'inbox')?.id
  if (!inbox) return none
  const own = [mailbox.address, ...(JSON.parse(mailbox.aliases || '[]') as string[])].map((a) => a.toLowerCase())
  const cutoff = Date.now() - FRESH_MS
  const fresh = (await jmap.getTriggerEmails(env, accountId, created.slice(-100), 1)).filter(
    (e) =>
      e.mailboxIds[inbox] &&
      !e.keywords.$draft &&
      !e.keywords.$seen &&
      Date.parse(e.receivedAt) >= cutoff &&
      !own.includes(e.from?.[0]?.email?.toLowerCase() ?? ''),
  )
  if (!fresh.length) return none

  if (fresh.length > MAX_EACH) {
    await push(env, { kind: 'email', userIds, domainId: mailbox.domain_id, title: `${fresh.length} new emails`, body: mailbox.address, path: '/' })
    return { notified: fresh.length }
  }
  for (const e of fresh) {
    const from = e.from?.[0]
    const subject = e.subject?.trim() || '(no subject)'
    const query = new URLSearchParams({ mailboxId, threadId: e.threadId, id: e.id, subject })
    await push(env, {
      kind: 'email',
      userIds,
      domainId: mailbox.domain_id,
      title: from?.name?.trim() || from?.email || 'New email',
      body: subject,
      path: `/thread?${query.toString()}`,
    })
  }
  return { notified: fresh.length }
}
