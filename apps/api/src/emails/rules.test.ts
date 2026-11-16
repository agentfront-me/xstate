// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeBase64, newEmailId, nextStatus, overallStatus, requestHash, retryAfterSeconds, sendInput } from './rules.ts'

const base = { from: 'Billing@Acme.test', to: ['ann@example.com'], subject: 'Hi', text: 'Hello' }
const issues = (value: unknown) => {
  const r = sendInput.safeParse(value)
  return r.success ? [] : r.error.issues.map((i) => i.message)
}

describe('sendInput', () => {
  it('accepts the smallest message and fills in the defaults', () => {
    const input = sendInput.parse(base)
    assert.deepEqual(input.from, { email: 'billing@acme.test', name: null })
    assert.deepEqual(input.to, [{ email: 'ann@example.com', name: null }])
    assert.equal(input.saveToSent, false)
  })

  it('takes addresses as a string or as { email, name }', () => {
    const input = sendInput.parse({ ...base, from: { email: 'billing@acme.test', name: 'Acme Billing' }, cc: [{ email: 'Bob@Example.com' }] })
    assert.deepEqual(input.from, { email: 'billing@acme.test', name: 'Acme Billing' })
    assert.deepEqual(input.cc, [{ email: 'bob@example.com', name: null }])
  })

  it('needs a recipient in to, and text or html', () => {
    assert.match(issues({ ...base, to: [] }).join(), /at least one recipient/)
    assert.match(issues({ from: base.from, to: base.to, subject: 'Hi' }).join(), /text, html or both/)
    assert.deepEqual(issues({ from: base.from, to: base.to, subject: 'Hi', html: '<p>Hello</p>' }), [])
  })

  it('refuses an address listed twice, whatever the case or the field', () => {
    assert.match(issues({ ...base, cc: ['ANN@example.com'] }).join(), /listed more than once/)
  })

  it('refuses more than 50 recipients in total', () => {
    const many = (prefix: string) => Array.from({ length: 30 }, (_, i) => `${prefix}${i}@example.com`)
    assert.match(issues({ ...base, to: many('a'), cc: many('b') }).join(), /at most 50 recipients/)
  })

  it('refuses fields it does not know, so a typo is not silently ignored', () => {
    assert.ok(issues({ ...base, save_to_sent: true }).length)
  })

  it('only lets X- and unsubscribe headers through, on one line', () => {
    assert.deepEqual(issues({ ...base, headers: { 'X-Order-Id': '42', 'List-Unsubscribe': '<https://acme.test/u/1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }), [])
    assert.match(issues({ ...base, headers: { Bcc: 'eve@example.com' } }).join(), /Only X-/)
    assert.match(issues({ ...base, headers: { 'X-A': 'one\r\nBcc: eve@example.com' } }).join(), /one line/)
  })

  it('checks tag names and how many there are', () => {
    assert.deepEqual(issues({ ...base, tags: { campaign: 'welcome', order_id: '42' } }), [])
    assert.match(issues({ ...base, tags: { 'bad name': 'x' } }).join(), /tag name/)
    assert.match(issues({ ...base, tags: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`t${i}`, 'x'])) }).join(), /At most 10 tags/)
  })

  it('checks attachments', () => {
    const file = { name: 'invoice.pdf', type: 'application/pdf', content: 'aGVsbG8=' }
    assert.deepEqual(issues({ ...base, attachments: [file] }), [])
    assert.ok(issues({ ...base, attachments: [{ ...file, name: '../etc/passwd' }] }).length)
    assert.ok(issues({ ...base, attachments: [{ ...file, type: 'pdf' }] }).length)
    assert.match(issues({ ...base, attachments: [{ ...file, contentId: 'logo' }, { ...file, contentId: 'logo' }] }).join(), /contentId/)
  })
})

describe('decodeBase64', () => {
  it('decodes, ignoring line breaks', () => {
    assert.deepEqual([...decodeBase64('aGVs\nbG8=')!], [104, 101, 108, 108, 111])
  })
  it('returns null for anything that is not base64', () => {
    for (const bad of ['', 'not base64!', 'a', 'aGVsbG8*']) assert.equal(decodeBase64(bad), null, bad)
  })
})

describe('requestHash', () => {
  it('is the same for the same request and different for a different one', async () => {
    const a = await requestHash(sendInput.parse(base))
    assert.equal(a, await requestHash(sendInput.parse({ ...base })))
    assert.notEqual(a, await requestHash(sendInput.parse({ ...base, subject: 'Hi again' })))
  })
})

describe('overallStatus', () => {
  it('is how far the slowest recipient has got while nothing went wrong', () => {
    assert.equal(overallStatus(['queued', 'queued']), 'queued')
    assert.equal(overallStatus(['sent', 'sent']), 'sent')
    assert.equal(overallStatus(['delivered', 'sent']), 'sent')
    assert.equal(overallStatus(['delivered', 'delivered']), 'delivered')
  })
  it('is bounced or complained when every recipient is', () => {
    assert.equal(overallStatus(['bounced', 'bounced']), 'bounced')
    assert.equal(overallStatus(['complained']), 'complained')
  })
  it('is partial when only some failed, or they failed differently', () => {
    assert.equal(overallStatus(['delivered', 'bounced']), 'partial')
    assert.equal(overallStatus(['sent', 'complained']), 'partial')
    assert.equal(overallStatus(['bounced', 'complained']), 'partial')
  })
  it('leaves out recipients that were skipped as suppressed', () => {
    assert.equal(overallStatus(['delivered', 'suppressed']), 'delivered')
    assert.equal(overallStatus(['bounced', 'suppressed']), 'bounced')
  })
})

describe('nextStatus', () => {
  it('moves forward from sent', () => {
    assert.equal(nextStatus('sent', 'delivered'), 'delivered')
    assert.equal(nextStatus('sent', 'bounced'), 'bounced')
    assert.equal(nextStatus('delivered', 'complained'), 'complained')
  })
  it('does not let a late delivery hide a bounce or a complaint', () => {
    assert.equal(nextStatus('bounced', 'delivered'), 'bounced')
    assert.equal(nextStatus('complained', 'delivered'), 'complained')
  })
  it('never changes a recipient that was not sent to', () => {
    assert.equal(nextStatus('suppressed', 'delivered'), 'suppressed')
  })
})

describe('ids and limits', () => {
  it('makes ids that start with em_', () => {
    assert.match(newEmailId(), /^em_[a-z0-9]{24}$/)
    assert.notEqual(newEmailId(), newEmailId())
  })
  it('says how long until a cap has room again', () => {
    assert.equal(retryAfterSeconds('Sending limit reached: at most 100 outside recipients an hour from one mailbox. Try again later.'), 3600)
    assert.equal(retryAfterSeconds('Sending limit reached: at most 500 outside recipients a day from one mailbox. Try again later.'), 86_400)
  })
})
