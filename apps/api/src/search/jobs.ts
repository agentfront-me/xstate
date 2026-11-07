// Background indexing for Storage search: the SEARCH_INDEX queue and the hourly cron.
//
// Every new file version and attachment puts an `index` job on the queue (enqueueIndex, called from storage/ and
// mail-sync), and mail sync puts the messages it sees arrive on it in batches (enqueueEmails); the consumer runs
// search/indexer for each. The hourly run is the safety net and the backfill: it queues searchable files that have
// no search_docs row (lost jobs, and everything from before search existed), retries failures once a day, and
// deletes the vectors of documents whose file or mailbox is gone.

import * as searchDb from '../db/search'
import { indexEmails, indexFile, removeDocument, type EmailIndexEnv } from './indexer'

export type SearchJob = { kind: 'index'; fileId: string } | { kind: 'index-emails'; mailboxId: string; emailIds: string[] }

/** Files per hourly run, so a backfill of a big organization spreads over a few hours without starving mail sync. */
const BACKFILL_PER_HOUR = 500
const RETRY_PER_HOUR = 100
const SWEEP_PER_HOUR = 200
const RETRY_AFTER_HOURS = 24
/** Messages per index-emails job: one Email/get and one embedding pass each. */
export const EMAILS_PER_JOB = 50

async function send(env: Pick<Env, 'SEARCH_INDEX'>, jobs: SearchJob[]): Promise<void> {
  if (!jobs.length) return
  try {
    // sendBatch takes up to 100 messages.
    for (let i = 0; i < jobs.length; i += 100) await env.SEARCH_INDEX.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })))
  } catch (err) {
    console.error('search: queueing index jobs failed', err)
  }
}

/** Queues files for indexing. Best effort: a lost job is picked up by the hourly backfill. */
export function enqueueIndex(env: Pick<Env, 'SEARCH_INDEX'>, fileIds: string[]): Promise<void> {
  return send(env, fileIds.map((fileId) => ({ kind: 'index', fileId })))
}

/** Queues a mailbox's messages for indexing, EMAILS_PER_JOB per job. */
export function enqueueEmails(env: Pick<Env, 'SEARCH_INDEX'>, mailboxId: string, emailIds: string[]): Promise<void> {
  const jobs: SearchJob[] = []
  for (let i = 0; i < emailIds.length; i += EMAILS_PER_JOB) {
    jobs.push({ kind: 'index-emails', mailboxId, emailIds: emailIds.slice(i, i + EMAILS_PER_JOB) })
  }
  return send(env, jobs)
}

/** Queue consumer. The same file queued twice in one batch is indexed once. */
export async function consume(batch: MessageBatch<SearchJob>, env: EmailIndexEnv): Promise<void> {
  const byFile = new Map<string, Message<SearchJob>[]>()
  for (const message of batch.messages) {
    if (message.body.kind !== 'index') continue
    const list = byFile.get(message.body.fileId) ?? []
    list.push(message)
    byFile.set(message.body.fileId, list)
  }
  for (const [fileId, messages] of byFile) {
    try {
      const outcome = await indexFile(env, fileId)
      if (outcome.status !== 'stale') console.log('search-index', JSON.stringify(outcome))
      for (const m of messages) m.ack()
    } catch (err) {
      console.error(`search-index: file ${fileId} failed`, err)
      for (const m of messages) m.retry({ delaySeconds: 60 * m.attempts })
    }
  }
  for (const message of batch.messages) {
    if (message.body.kind !== 'index-emails') continue
    try {
      const outcome = await indexEmails(env, message.body.mailboxId, message.body.emailIds)
      if (outcome.indexed || outcome.empty) console.log('search-index-emails', JSON.stringify(outcome))
      message.ack()
    } catch (err) {
      console.error(`search-index-emails: mailbox ${message.body.mailboxId} failed`, err)
      message.retry({ delaySeconds: 60 * message.attempts })
    }
  }
}

export type HourlyResult = { queued: number; retried: number; swept: number; sweepFailed: number }

/** Cron, hourly: backfill, retries and the sweep. */
export async function hourly(env: EmailIndexEnv & Pick<Env, 'SEARCH_INDEX'>, now = new Date()): Promise<HourlyResult> {
  const result: HourlyResult = { queued: 0, retried: 0, swept: 0, sweepFailed: 0 }

  const unindexed = await searchDb.unindexedFileIds(env.DB, BACKFILL_PER_HOUR)
  await enqueueIndex(env, unindexed)
  result.queued = unindexed.length

  const before = new Date(now.getTime() - RETRY_AFTER_HOURS * 3_600_000).toISOString()
  const failed = await searchDb.failedFileIds(env.DB, before, RETRY_PER_HOUR)
  await enqueueIndex(env, failed)
  const failedEmails = new Map<string, string[]>()
  for (const row of await searchDb.failedEmailDocs(env.DB, before, RETRY_PER_HOUR)) {
    const doc = searchDb.parseDoc(row.doc_id)
    if (doc?.kind === 'email') failedEmails.set(doc.mailboxId, [...(failedEmails.get(doc.mailboxId) ?? []), doc.emailId])
  }
  for (const [mailboxId, emailIds] of failedEmails) await enqueueEmails(env, mailboxId, emailIds)
  result.retried = failed.length + [...failedEmails.values()].reduce((n, ids) => n + ids.length, 0)

  for (const row of await searchDb.orphans(env.DB, SWEEP_PER_HOUR)) {
    try {
      await removeDocument(env, row)
      result.swept++
    } catch (err) {
      result.sweepFailed++
      console.error(`search-sweep: deleting vectors of ${row.doc_id} failed`, err)
    }
  }
  return result
}
