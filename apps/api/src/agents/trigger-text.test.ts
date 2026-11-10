// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TriggerEmail } from '../mailserver/stalwart/mail.ts'
import { automated, emailTask, matchesRules, webhookTask } from './trigger-text.ts'

const email = (over: Partial<TriggerEmail> = {}): TriggerEmail => ({
  id: 'e1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: {},
  from: [{ name: 'Carlos Ruiz', email: 'carlos.ruiz@gmail.com' }],
  to: [{ name: null, email: 'support@ninjademo.store' }],
  cc: null,
  subject: 'Refund for order #1043',
  receivedAt: '2026-11-10T13:52:00Z',
  hasAttachment: true,
  preview: 'The lamp arrived shattered.',
  textBody: [{ partId: '1' }],
  bodyValues: { '1': { value: 'The lamp arrived shattered. Photos attached.', isTruncated: false } },
  'header:Auto-Submitted:asText': null,
  'header:Precedence:asText': null,
  'header:List-Id:asText': null,
  'header:List-Unsubscribe:asURLs': null,
  'header:X-Autoreply:asText': null,
  ...over,
})

describe('automated (loop guard)', () => {
  it('lets a person through', () => assert.equal(automated(email()), null))
  it('catches auto-replies, lists and no-reply senders', () => {
    assert.match(automated(email({ 'header:Auto-Submitted:asText': ' auto-replied' }))!, /Auto-Submitted/)
    assert.equal(automated(email({ 'header:Auto-Submitted:asText': 'no' })), null)
    assert.match(automated(email({ 'header:Precedence:asText': 'bulk' }))!, /Precedence/)
    assert.match(automated(email({ 'header:List-Unsubscribe:asURLs': ['mailto:x@y'] }))!, /Mailing list/)
    assert.match(automated(email({ from: [{ name: null, email: 'no-reply@shop.com' }] }))!, /No-reply/)
    assert.match(automated(email({ from: [{ name: null, email: 'MAILER-DAEMON@mx.example' }] }))!, /No-reply/)
    assert.equal(automated(email({ from: [{ name: null, email: 'noreen@shop.com' }] })), null)
  })
})

describe('matchesRules', () => {
  const none = { from: '', subjectContains: '', hasAttachment: null }
  it('matches everything with no rules', () => assert.equal(matchesRules(none, email()), true))
  it('checks sender, subject and attachment, case-insensitively', () => {
    assert.equal(matchesRules({ ...none, from: 'GMAIL.com' }, email()), true)
    assert.equal(matchesRules({ ...none, from: 'outlook.com' }, email()), false)
    assert.equal(matchesRules({ ...none, subjectContains: 'refund' }, email()), true)
    assert.equal(matchesRules({ ...none, subjectContains: 'invoice' }, email()), false)
    assert.equal(matchesRules({ ...none, hasAttachment: false }, email()), false)
  })
})

describe('emailTask', () => {
  it('gives the agent who, what and the ids to read the thread', () => {
    const task = emailTask({ id: 'mb1', address: 'support@ninjademo.store' }, email())
    assert.match(task, /^New email in support@ninjademo.store/)
    assert.match(task, /From: Carlos Ruiz <carlos.ruiz@gmail.com>/)
    assert.match(task, /\nmailboxId: mb1\nthreadId: t1\n/)
    assert.match(task, /The lamp arrived shattered. Photos attached./)
  })
  it('cuts very long bodies', () => {
    const long = email({ bodyValues: { '1': { value: 'x'.repeat(20_000), isTruncated: false } } })
    assert.match(emailTask({ id: 'mb1', address: 'a@b.c' }, long), /\[…message cut\]$/)
  })
})

describe('webhookTask', () => {
  const payload = { order: { id: 1043, total: 240 }, customer: { email: 'c@x.com' } }
  it('defaults to the whole payload', () => {
    assert.match(webhookTask({ name: 'Orders', template: '' }, payload), /Webhook "Orders" received this payload:\n\n\{\n {2}"order"/)
  })
  it('fills fields and leaves missing ones empty', () => {
    assert.equal(webhookTask({ name: 'x', template: 'Order {{order.id}} from {{payload.customer.email}} ({{nope.x}})' }, payload), 'Order 1043 from c@x.com ()')
  })
  it('takes plain text bodies as they are', () => {
    assert.equal(webhookTask({ name: 'x', template: 'Got: {{payload}}' }, 'hello'), 'Got: hello')
  })
})
