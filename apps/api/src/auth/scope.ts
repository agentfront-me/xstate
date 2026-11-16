import type { Actor } from './types'

/** Whether the actor's connection may touch this mailbox's mail. Always true for a person signed in themselves. */
export function inMailboxScope(actor: Pick<Actor, 'mailboxIds'>, mailboxId: string): boolean {
  return !actor.mailboxIds || actor.mailboxIds.includes(mailboxId)
}
