// The old copy queue (xstate-mailbox-store), which copied mail from Stalwart into each mailbox's store. Every mailbox
// is on the store now, so the consumer only acknowledges what is left until the queue is removed
// (docs/mailbox-store-plan.md, phase 5b).

export type MailboxStoreJob = { kind: string; mailboxId: string }

/** Queue consumer for xstate-mailbox-store. */
export async function consumeStore(batch: MessageBatch<MailboxStoreJob>): Promise<void> {
  for (const message of batch.messages) message.ack()
}
