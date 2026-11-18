// "New email" notifications, sent as each message is delivered into a mailbox (mailbox/receive.ts). What does not
// notify: agents' mailboxes, mail that isn't in the inbox, and mail the mailbox sent itself.

import * as devices from '../db/devices'
import * as accessDb from '../db/mailbox-access'
import * as mailboxesDb from '../db/mailboxes'
import { push } from './send'

/** "New email" for one message just delivered into a mailbox (mailbox/receive.ts). */
export async function notifyDelivered(
  env: Env,
  mailbox: mailboxesDb.MailboxRow,
  message: { id: string; threadId: string; folder: string; subject: string; from: { name: string | null; email: string } | undefined },
): Promise<{ notified: number }> {
  if (mailbox.kind === 'agent' || message.folder !== 'inbox') return { notified: 0 }
  const own = [mailbox.address, ...(JSON.parse(mailbox.aliases || '[]') as string[])].map((a) => a.toLowerCase())
  if (own.includes(message.from?.email.toLowerCase() ?? '')) return { notified: 0 }
  const userIds = (await accessDb.listToNotify(env.DB, mailbox.id)).map((a) => a.user_id)
  if (!(await devices.forUsers(env.DB, userIds, 'email', mailbox.domain_id)).length) return { notified: 0 }
  const subject = message.subject.trim() || '(no subject)'
  const query = new URLSearchParams({ mailboxId: mailbox.id, threadId: message.threadId, id: message.id, subject })
  await push(env, {
    kind: 'email',
    userIds,
    domainId: mailbox.domain_id,
    title: message.from?.name?.trim() || message.from?.email || 'New email',
    body: subject,
    path: `/thread?${query.toString()}`,
  })
  return { notified: 1 }
}
