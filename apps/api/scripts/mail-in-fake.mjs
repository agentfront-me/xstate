#!/usr/bin/env node
// Local development: delivers a message the way SES receiving would (docs/mailbox-store-plan.md, phase 2 step 1),
// by posting a made-up SNS notification that carries the message itself to /webhooks/ses-inbound. The local API
// must run with SES_MODE=fake, which skips the topic and signature checks there (never in production).
//
//   node scripts/mail-in-fake.mjs --to sofia@example.test [--from a@b.com] [--subject Hi] [--text Hello]
//   node scripts/mail-in-fake.mjs --to sofia@example.test --eml path/to/message.eml
//   options: --api http://localhost:8788  --ses-id <id> (reuse one to try a repeated delivery)
//            --reply-to-id <Message-ID> (sets In-Reply-To and References)  --spam  --virus
//
// Messages over about 70 KB don't fit in the queue job; use the real S3 path for those.

import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)

const to = opt('to')
if (!to) {
  console.error('Usage: node scripts/mail-in-fake.mjs --to <address> [--from …] [--subject …] [--text …] [--eml file]')
  process.exit(1)
}
const api = opt('api', 'http://localhost:8788')
const sesId = opt('ses-id', `fake-${randomUUID()}`)
const from = opt('from', 'someone@example.org')
const replyTo = opt('reply-to-id')

const eml = opt('eml')
  ? readFileSync(opt('eml'))
  : Buffer.from(
      [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${opt('subject', 'Hello from fake SES')}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomUUID()}@example.org>`,
        ...(replyTo ? [`In-Reply-To: <${replyTo}>`, `References: <${replyTo}>`] : []),
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        opt('text', 'This message came through the fake SES path.'),
        '',
      ].join('\r\n'),
    )

const verdict = (status) => ({ status })
const notification = {
  notificationType: 'Received',
  mail: { messageId: sesId, timestamp: new Date().toISOString(), source: from, destination: [to] },
  receipt: {
    timestamp: new Date().toISOString(),
    recipients: [to],
    spamVerdict: verdict(flag('spam') ? 'FAIL' : 'PASS'),
    virusVerdict: verdict(flag('virus') ? 'FAIL' : 'PASS'),
    spfVerdict: verdict('PASS'),
    dkimVerdict: verdict('PASS'),
    dmarcVerdict: verdict('PASS'),
    action: { type: 'SNS', topicArn: 'arn:aws:sns:us-east-2:000000000000:fake', encoding: 'BASE64' },
  },
  content: eml.toString('base64'),
}
const sns = {
  Type: 'Notification',
  MessageId: randomUUID(),
  TopicArn: 'arn:aws:sns:us-east-2:000000000000:fake',
  Message: JSON.stringify(notification),
  Timestamp: new Date().toISOString(),
  SignatureVersion: '1',
  Signature: 'fake',
  SigningCertURL: 'https://sns.us-east-2.amazonaws.com/fake.pem',
}

const res = await fetch(`${api}/webhooks/ses-inbound`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(sns) })
console.log(res.status, await res.text(), `(ses id ${sesId})`)
