// The mailbox store's copy jobs (./shadow.ts) on a queue of their own, so a big mailbox's copy never holds up
// search indexing for everyone else. `store-emails` copies messages into the store; `store-raw` copies raw messages
// to the organization's bucket and records where their attachments sit; `store-threading` fills in the threading
// headers of copies made before they were kept (phase 4c), a batch per job, queueing the next itself.

import { copyRaw, fillThreading, queueRawAfterCopy, storeEmails, type ShadowEnv } from './shadow'

export type MailboxStoreJob =
  | { kind: 'store-emails' | 'store-raw'; mailboxId: string; emailIds: string[] }
  | { kind: 'store-threading'; mailboxId: string }

export async function enqueueStoreJobs(env: Pick<Env, 'STORE_COPY'>, jobs: MailboxStoreJob[]): Promise<void> {
  // sendBatch takes up to 100 messages.
  for (let i = 0; i < jobs.length; i += 100) await env.STORE_COPY.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })))
}

/** A minute more per attempt, up to ten, with jitter. */
const retryDelay = (attempts: number) => Math.min(60 * attempts, 600) + Math.floor(Math.random() * 60)

/** Runs one job. Throws so the queue retries it. */
export async function runStoreJob(env: ShadowEnv, job: MailboxStoreJob): Promise<void> {
  if (job.kind === 'store-threading') {
    const filled = await fillThreading(env, job.mailboxId)
    if (filled.filled || filled.missing) console.log('mailbox-store-threading', JSON.stringify(filled))
    if (filled.more) await enqueueStoreJobs(env, [{ kind: 'store-threading', mailboxId: job.mailboxId }])
  } else if (job.kind === 'store-emails') {
    const stored = await storeEmails(env, job.mailboxId, job.emailIds)
    const rawQueued = stored ? await queueRawAfterCopy(env, job.mailboxId) : 0
    if (stored) console.log('mailbox-store-copy', JSON.stringify({ mailboxId: job.mailboxId, stored, rawQueued }))
  } else {
    const copied = await copyRaw(env, job.mailboxId, job.emailIds)
    if (copied.stored || copied.skipped) console.log('mailbox-store-raw', JSON.stringify(copied))
  }
}

/** Queue consumer for xstate-mailbox-store. */
export async function consumeStore(batch: MessageBatch<MailboxStoreJob>, env: ShadowEnv): Promise<void> {
  for (const message of batch.messages) {
    try {
      await runStoreJob(env, message.body)
      message.ack()
    } catch (err) {
      console.error(`mailbox-${message.body.kind}: mailbox ${message.body.mailboxId} failed`, err)
      message.retry({ delaySeconds: retryDelay(message.attempts) })
    }
  }
}
