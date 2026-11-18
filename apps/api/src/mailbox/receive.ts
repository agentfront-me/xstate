// Receiving mail without Stalwart (docs/mailbox-store-plan.md, phase 2 step 1). SES saves each message to S3 and
// tells /webhooks/ses-inbound (jobs/ses-inbound.ts), which queues an InboundJob on MAIL_IN. This consumer finds the
// recipient mailboxes, keeps the raw message in the organization's bucket, delivers it into each mailbox's store,
// tells the apps, and deletes it from S3. Every step is safe to repeat: a retried job finds what was delivered by
// SES's message id and stops there.
//
// Only mailboxes with backend = 'store' receive this way. Mail for any other address is dropped and logged, never
// bounced: SES has already accepted it, so a bounce would go to a sender who may be forged.

import * as accessDb from '../db/mailbox-access'
import * as addressesDb from '../db/addresses'
import * as mailboxesDb from '../db/mailboxes'
import * as orgsDb from '../db/organizations'
import * as dropsDb from '../db/mail-drops'
import type { MailboxRow } from '../db/mailboxes'
import { announce } from '../live/announce'
import { stripFooter } from '../mailserver/footer'
import { notifyDelivered } from '../push/new-mail'
import { organizationBucket } from '../storage/buckets'
import { deleteObject, putObject } from '../storage/r2'
import { queueMailEvent } from './events'
import { messageIds, previewOf, ulid, type InboundJob } from './inbound'
import { decodePart } from './mime'
import { fileParts, parseRaw, partName, type ParsedMessage } from './parse'
import { deleteInbound, getInbound, quarantineInbound, type InboundEnv } from './s3'
import { rawKey } from './shadow'
import { decideSpam } from './spam'
import type { StoreDelivery } from './store'
import { store } from './stub'

/** SES accepts messages up to 40 MB; anything larger in the bucket isn't from SES. */
const MAX_BYTES = 45 * 1024 * 1024

export type ReceiveEnv = Env & InboundEnv

export async function consumeInbound(batch: MessageBatch<InboundJob>, env: ReceiveEnv): Promise<void> {
  // One at a time: a message can be 40 MB, and a Worker has 128 MB.
  for (const message of batch.messages) {
    try {
      const result = await receive(env, message.body)
      console.log('mail-in', JSON.stringify(result))
      message.ack()
    } catch (err) {
      console.error(`mail-in: ${message.body.sesId} failed (attempt ${message.attempts})`, err)
      message.retry({ delaySeconds: Math.min(30 * message.attempts, 300) })
    }
  }
}

type ReceiveResult = {
  sesId: string
  delivered: { mailboxId: string; id: string; folder: string; duplicate: boolean; spam?: { score: number; reasons: string[] } }[]
  dropped: { address: string; reason: 'unknown_address' | 'not_on_store' }[]
  /** SES found a virus: delivered nowhere. `quarantined` is where it was moved in S3, when it came through S3. */
  virus?: boolean
  quarantined?: string
  gone?: boolean
}

async function receive(env: ReceiveEnv, job: InboundJob): Promise<ReceiveResult> {
  const result: ReceiveResult = { sesId: job.sesId, delivered: [], dropped: [] }

  // Who it is for: the envelope recipients, each looked up among xstate's addresses. One mailbox can have several.
  const mailboxes = new Map<string, MailboxRow>()
  for (const address of job.recipients) {
    const owner = await addressesDb.findByAddress(env.DB, address)
    const mailbox = owner ? await mailboxesDb.find(env.DB, owner.mailbox_id) : null
    if (!mailbox) result.dropped.push({ address, reason: 'unknown_address' })
    else if (mailbox.backend !== 'store') result.dropped.push({ address, reason: 'not_on_store' })
    else mailboxes.set(mailbox.id, mailbox)
  }
  // The delivery log: drops have no mailbox, so they go to D1 under the organization that has the domain.
  if (result.dropped.length) {
    const now = new Date().toISOString()
    const writes = await Promise.all(
      result.dropped.map(async (d) =>
        dropsDb.insert(env.DB, {
          organization_id: await dropsDb.organizationOfAddress(env.DB, d.address),
          ses_id: job.sesId,
          at: now,
          sender: job.source ?? null,
          recipient: d.address,
          reason: d.reason,
        }),
      ),
    )
    await env.DB.batch(writes)
  }

  // SES found a virus: delivered nowhere, kept a week for support to look at.
  if (job.verdicts.virus === 'FAIL') {
    result.virus = true
    for (const mailbox of mailboxes.values()) {
      await (await store(env, mailbox.id)).logDelivery([
        { step: 'refused', sesId: job.sesId, address: job.source ?? null, detail: { reason: 'virus', by: 'Amazon SES', verdicts: job.verdicts } },
      ])
    }
    if (job.bucket && job.key) result.quarantined = await quarantineInbound(env, job.bucket, job.key)
    return result
  }

  if (mailboxes.size) {
    const raw = await rawMessage(env, job)
    if (!raw) {
      // Already received and deleted by an earlier try, or expired: nothing left to deliver.
      result.gone = true
      return result
    }
    if (raw.length > MAX_BYTES) throw new Error(`message is ${raw.length} bytes, over ${MAX_BYTES}`)
    const parsed = await parseRaw(raw)
    const orgs = new Map<string, Promise<OrgKnowledge>>()
    for (const mailbox of mailboxes.values()) {
      if (!orgs.has(mailbox.organization_id)) orgs.set(mailbox.organization_id, orgKnowledge(env, mailbox.organization_id, parsed))
      result.delivered.push(await deliverTo(env, mailbox, job, raw, parsed, await orgs.get(mailbox.organization_id)!))
    }
  }
  if (job.bucket && job.key) await deleteInbound(env, job.bucket, job.key)
  return result
}

async function rawMessage(env: ReceiveEnv, job: InboundJob): Promise<Uint8Array | null> {
  if (job.content) return Uint8Array.from(atob(job.content), (c) => c.charCodeAt(0))
  if (!job.bucket || !job.key) throw new Error('job has neither the message nor where it is')
  return getInbound(env, job.bucket, job.key)
}

/** What the organization knows that bears on the spam decision: its domains and names, and whether the sender is a contact. */
type OrgKnowledge = { domains: string[]; names: string[]; contact: boolean }

async function orgKnowledge(env: ReceiveEnv, organizationId: string, parsed: ParsedMessage): Promise<OrgKnowledge> {
  const from = parsed.from[0]?.email
  const [identity, known] = await Promise.all([
    orgsDb.identity(env.DB, organizationId),
    from ? env.AUDIENCE.get(env.AUDIENCE.idFromName(organizationId)).knows([from]).catch((err) => (console.error('mail-in: contact lookup failed', err), [])) : [],
  ])
  return { ...identity, contact: known.length > 0 }
}

async function deliverTo(
  env: ReceiveEnv,
  mailbox: MailboxRow,
  job: InboundJob,
  raw: Uint8Array,
  parsed: ParsedMessage,
  org: OrgKnowledge,
): Promise<ReceiveResult['delivered'][number]> {
  const stub = await store(env, mailbox.id)
  const already = await stub.findBySes(job.sesId)
  if (already) return { mailboxId: mailbox.id, id: already.id, folder: '', duplicate: true }

  // Inbox or Junk (./spam.ts): SES's verdicts, the headers, and what this mailbox and its organization know.
  const from = parsed.from[0] ?? null
  const standing = from ? await stub.standing(from.email) : { wrote: false, verdict: null }
  const spam = decideSpam({
    ses: job.verdicts,
    dmarcPolicy: job.verdicts.dmarcPolicy || null,
    from,
    replyTo: parsed.replyTo.map((a) => a.email),
    senderVerdict: standing.verdict,
    known: standing.wrote || org.contact,
    orgDomains: org.domains,
    orgNames: org.names,
  })

  const id = ulid()
  const key = rawKey(mailbox.id, id)
  const bucket = await organizationBucket(env, mailbox.organization_id)
  await putObject(env, bucket, key, raw, { contentType: 'message/rfc822', metadata: { 'email-id': id, 'ses-id': job.sesId } })

  const files = fileParts(parsed.parts)
  const text = stripFooter(parsed.text)
  const delivery: StoreDelivery = {
    id,
    sesId: job.sesId,
    messageId: parsed.messageId,
    inReplyTo: messageIds(parsed.inReplyTo)[0] ?? null,
    references: messageIds(parsed.references),
    subject: parsed.subject,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    own: [mailbox.address, ...(JSON.parse(mailbox.aliases || '[]') as string[])],
    preview: previewOf(text),
    text,
    receivedAt: job.receivedAt,
    size: raw.length,
    // As mail apps show it: a file that isn't an image shown inside the message.
    hasAttachment: files.some((p) => p.disposition !== 'inline' || !p.contentId),
    rawKey: key,
    attachments: files.map((p) => ({
      name: partName(p),
      type: p.type,
      size: decodePart(raw.subarray(p.start, p.start + p.length), p.encoding).length,
      start: p.start,
      length: p.length,
      encoding: p.encoding,
    })),
    junk: spam.folder === 'junk',
    verdicts: { ...job.verdicts, spamScore: String(spam.score), spamReasons: spam.reasons.join('; ') },
  }
  const stored = await stub.deliver(delivery)
  if (stored.duplicate) {
    // Another try delivered it in the meantime under its own id: this copy is not needed.
    await deleteObject(env, bucket, key).catch((err) => console.error(`mail-in: deleting spare copy ${key} failed`, err))
    return { mailboxId: mailbox.id, id: stored.id, folder: stored.folder, duplicate: true }
  }
  await stub.logDelivery([
    {
      step: 'delivered',
      emailId: id,
      sesId: job.sesId,
      address: parsed.from[0]?.email ?? job.source ?? null,
      detail: {
        folder: stored.folder,
        to: job.recipients.filter((a) => [mailbox.address, ...(JSON.parse(mailbox.aliases || '[]') as string[])].includes(a)),
        envelopeFrom: job.source ?? null,
        size: raw.length,
        verdicts: job.verdicts,
        spam: { score: spam.score, reasons: spam.reasons },
      },
    },
  ])

  // Filing, search and agents, on their own queue (./events.ts).
  await queueMailEvent(env, { kind: 'new', mailboxId: mailbox.id, ids: [id], direction: 'in' })
  // The apps: a live update for whoever has the mailbox open, and "new email" on phones.
  const userIds = (await accessDb.list(env.DB, mailbox.id)).map((a) => a.user_id)
  if (userIds.length) await announce(env, mailbox.organization_id, { type: 'mail', mailboxId: mailbox.id }, userIds)
  await notifyDelivered(env, mailbox, { id, threadId: stored.threadId, folder: stored.folder, subject: parsed.subject, from: parsed.from[0] }).catch((err) =>
    console.error(`mail-in: push for ${mailbox.id} failed`, err),
  )
  return { mailboxId: mailbox.id, id, folder: stored.folder, duplicate: false, spam: { score: spam.score, reasons: spam.reasons } }
}
