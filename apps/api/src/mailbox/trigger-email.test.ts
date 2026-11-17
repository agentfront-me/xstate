// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { automated, emailTask, matchesRules } from '../agents/trigger-text.ts'
import { triggerEmailOf, type TriggerSource } from './trigger-email.ts'

const base: TriggerSource = {
  id: '01M7ABC',
  threadId: '01M7THR',
  receivedAt: '2026-11-18T07:00:00Z',
  hasAttachment: true,
  subject: 'Invoice 314',
  from: [{ name: 'Jane', email: 'jane@example.org' }],
  to: [{ name: null, email: 'hello@99events.com' }],
  cc: [],
  text: 'Please find the invoice attached.',
  headers: {},
}

describe('triggerEmailOf', () => {
  it('gives the agent task the text, sender and ids', () => {
    const task = emailTask({ id: 'mb1', address: 'hello@99events.com' }, triggerEmailOf(base))
    assert.match(task, /From: Jane <jane@example\.org>/)
    assert.match(task, /Has attachments\./)
    assert.match(task, /threadId: 01M7THR/)
    assert.match(task, /Please find the invoice attached\./)
  })

  it('passes ordinary mail through the loop guard', () => {
    assert.equal(automated(triggerEmailOf(base)), null)
  })

  it('keeps the headers the loop guard reads', () => {
    assert.equal(automated(triggerEmailOf({ ...base, headers: { 'auto-submitted': 'auto-replied' } })), 'Auto-Submitted: auto-replied')
    assert.equal(automated(triggerEmailOf({ ...base, headers: { precedence: 'bulk' } })), 'Precedence: bulk')
    assert.equal(automated(triggerEmailOf({ ...base, headers: { 'list-unsubscribe': '<mailto:u@x.org>, <https://x.org/u>' } })), 'Mailing list')
    assert.deepEqual(triggerEmailOf({ ...base, headers: { 'list-unsubscribe': '<mailto:u@x.org>, <https://x.org/u>' } })['header:List-Unsubscribe:asURLs'], [
      'mailto:u@x.org',
      'https://x.org/u',
    ])
  })

  it('works with the rules', () => {
    assert.equal(matchesRules({ from: 'example.org', subjectContains: null, hasAttachment: null } as never, triggerEmailOf(base)), true)
    assert.equal(matchesRules({ from: null, subjectContains: null, hasAttachment: false } as never, triggerEmailOf(base)), false)
  })

  it('caps the body', () => {
    const e = triggerEmailOf({ ...base, text: 'x'.repeat(20_000) })
    assert.equal(e.bodyValues.text!.value.length, 16_000)
    assert.equal(e.bodyValues.text!.isTruncated, true)
  })
})
