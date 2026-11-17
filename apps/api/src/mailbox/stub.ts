// The way to reach a mailbox's MailboxStore. On its own so both the mail code and the shadow copy can import it.

import { getAgentByName } from 'agents'
import type { MailboxStore } from './store'

export const store = (env: Pick<Env, 'MAILBOX_STORE'>, mailboxId: string) => getAgentByName<Env, MailboxStore>(env.MAILBOX_STORE, mailboxId)
