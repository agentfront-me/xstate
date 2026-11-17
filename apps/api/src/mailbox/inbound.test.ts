// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inboundJob, messageIds, previewOf, subjectKey, ulid, ulidTime } from './inbound.ts'

const received = (over: Record<string, unknown> = {}) => ({
  notificationType: 'Received',
  mail: { messageId: 'ses-123', timestamp: '2026-11-17T18:00:00.123Z' },
  receipt: {
    timestamp: '2026-11-17T18:00:01.456Z',
    recipients: ['Asif@Pilot.xstate.com', 'asif@pilot.xstate.com', 'team@pilot.xstate.com'],
    spamVerdict: { status: 'PASS' },
    virusVerdict: { status: 'FAIL' },
    spfVerdict: { status: 'pass' },
    dkimVerdict: { status: 'GRAY' },
    dmarcVerdict: {},
    action: { type: 'S3', bucketName: 'xstate-mail-inbound', objectKey: 'inbound/abc' },
  },
  ...over,
})

describe('inboundJob', () => {
  it('reads an S3 notification into a job', () => {
    assert.deepEqual(inboundJob(received()), {
      sesId: 'ses-123',
      bucket: 'xstate-mail-inbound',
      key: 'inbound/abc',
      recipients: ['asif@pilot.xstate.com', 'team@pilot.xstate.com'],
      verdicts: { spam: 'PASS', virus: 'FAIL', spf: 'PASS', dkim: 'GRAY', dmarc: '' },
      receivedAt: '2026-11-17T18:00:01Z',
    })
  })

  it('carries a small message sent in the notification, as base64', () => {
    const job = inboundJob({ ...received(), content: 'Subject: Hi\r\n\r\nHéllo', receipt: { ...received().receipt, action: { type: 'SNS', encoding: 'UTF8' } } })!
    assert.equal(job.bucket, null)
    assert.equal(Buffer.from(job.content!, 'base64').toString('utf8'), 'Subject: Hi\r\n\r\nHéllo')
    const b64 = inboundJob({ ...received(), content: 'U3ViamVjdDog\nSGk=', receipt: { ...received().receipt, action: { type: 'SNS', encoding: 'BASE64' } } })!
    assert.equal(b64.content, 'U3ViamVjdDogSGk=')
  })

  it('leaves out a carried message too large for the queue', () => {
    const job = inboundJob({ ...received(), content: 'x'.repeat(200_000) })!
    assert.equal(job.content, undefined)
  })

  it('ignores anything that is not a received message', () => {
    assert.equal(inboundJob({ notificationType: 'Bounce' }), null)
    assert.equal(inboundJob({ notificationType: 'Received', receipt: {} }), null)
    assert.equal(inboundJob(null), null)
  })
})

describe('ulid', () => {
  it('is 26 uppercase characters that sort by time', () => {
    const a = ulid(1_700_000_000_000)
    const b = ulid(1_700_000_000_001)
    assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.ok(a < b)
  })

  it('gives back the time it was made', () => {
    assert.equal(ulidTime(ulid(1_700_000_000_123)), 1_700_000_000_123)
    assert.ok(Number.isNaN(ulidTime('fsbiaabmqk')))
  })

  it('can never equal a Stalwart id, which is lowercase', () => {
    assert.notEqual(ulid().toLowerCase(), ulid())
  })
})

describe('subjectKey', () => {
  it('drops reply and forward prefixes, however many', () => {
    assert.equal(subjectKey('Re: RE: Fwd: Invoice 314'), 'invoice 314')
    assert.equal(subjectKey('AW: Re[2]: Angebot'), 'angebot')
    assert.equal(subjectKey('[Team] Re: Launch  plan'), 'launch plan')
  })

  it('keeps words that only look like prefixes', () => {
    assert.equal(subjectKey('Refund for order 9'), 'refund for order 9')
    assert.equal(subjectKey('Fwding rules'), 'fwding rules')
  })
})

describe('messageIds', () => {
  it('reads bracketed ids in order', () => {
    assert.deepEqual(messageIds('<a@x.com> <b@y.com>\r\n <c@z.com>'), ['a@x.com', 'b@y.com', 'c@z.com'])
  })

  it('accepts ids sent without brackets', () => {
    assert.deepEqual(messageIds('a@x.com b@y.com'), ['a@x.com', 'b@y.com'])
    assert.deepEqual(messageIds(null), [])
  })
})

describe('previewOf', () => {
  it('collapses whitespace and cuts', () => {
    assert.equal(previewOf('Hello\n\n  there', 8), 'Hello th')
  })
})
