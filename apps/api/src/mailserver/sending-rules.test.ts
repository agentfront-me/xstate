// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CALENDAR_LIMITS, calendarOverLimit, judge, LIMITS, overLimit, SUSPEND } from './sending-rules.ts'

const box = SUSPEND.mailbox
const org = SUSPEND.organization

describe('judge', () => {
  it('leaves a clean sender alone', () => {
    assert.equal(judge({ delivered: 3000, bounces: 5, complaints: 1 }, box), null)
  })
  it('needs the minimum count, however high the rate', () => {
    assert.equal(judge({ delivered: 2, bounces: 9, complaints: 2 }, box), null)
  })
  it('suspends on complaints at the minimum count and rate', () => {
    const v = judge({ delivered: 3000, bounces: 0, complaints: 3 }, box)
    assert.equal(v?.reason, 'complaints')
    assert.match(v!.detail, /3 spam complaints out of 3000/)
  })
  it('does not suspend high volume with complaints under the rate', () => {
    assert.equal(judge({ delivered: 20_000, bounces: 0, complaints: 5 }, box), null)
  })
  it('suspends on hard bounces past 3%', () => {
    assert.equal(judge({ delivered: 300, bounces: 10, complaints: 0 }, box)?.reason, 'bounces')
    assert.equal(judge({ delivered: 400, bounces: 10, complaints: 0 }, box), null)
  })
  it('complaints win over bounces', () => {
    assert.equal(judge({ delivered: 100, bounces: 50, complaints: 3 }, box)?.reason, 'complaints')
  })
  it('organizations need more events than a mailbox', () => {
    assert.equal(judge({ delivered: 100, bounces: 20, complaints: 4 }, org), null)
    assert.equal(judge({ delivered: 100, bounces: 25, complaints: 0 }, org)?.reason, 'bounces')
  })
  it('stays below what Amazon SES reviews at', () => {
    assert.ok(SUSPEND.bounceRate < 0.05 && SUSPEND.complaintRate < 0.001)
  })
})

describe('overLimit', () => {
  const ok = { mailboxHour: LIMITS.mailbox.hour, mailboxDay: LIMITS.mailbox.day, orgHour: LIMITS.organization.hour, orgDay: LIMITS.organization.day }
  it('allows usage up to each cap', () => assert.equal(overLimit(ok), null))
  it('names the cap that was passed', () => {
    assert.match(overLimit({ ...ok, mailboxHour: ok.mailboxHour + 1 })!, /an hour from one mailbox/)
    assert.match(overLimit({ ...ok, mailboxDay: ok.mailboxDay + 1 })!, /a day from one mailbox/)
    assert.match(overLimit({ ...ok, orgHour: ok.orgHour + 1 })!, /an hour for your organization/)
    assert.match(overLimit({ ...ok, orgDay: ok.orgDay + 1 })!, /a day for your organization/)
  })
})

describe('calendarOverLimit', () => {
  const ok = { hour: 0, day: 0, topRecipient: null, topRecipientHour: 0 }
  it('allows up to the caps, inclusive', () => {
    assert.equal(calendarOverLimit({ ...ok, hour: CALENDAR_LIMITS.hour, day: CALENDAR_LIMITS.day }), null)
    assert.equal(calendarOverLimit({ ...ok, topRecipient: 'a@b.co', topRecipientHour: CALENDAR_LIMITS.perRecipientHour }), null)
  })
  it('names the cap that was passed', () => {
    assert.match(calendarOverLimit({ ...ok, hour: CALENDAR_LIMITS.hour + 1 })!, /an hour from one calendar/)
    assert.match(calendarOverLimit({ ...ok, day: CALENDAR_LIMITS.day + 1 })!, /a day from one calendar/)
    assert.match(calendarOverLimit({ ...ok, topRecipient: 'a@b.co', topRecipientHour: CALENDAR_LIMITS.perRecipientHour + 1 })!, /to a@b\.co/)
  })
  it('stays under Stalwart: 40 an hour and 200 a day per sender, 25 an hour per recipient', () => {
    assert.ok(CALENDAR_LIMITS.hour < 40 && CALENDAR_LIMITS.day < 200 && CALENDAR_LIMITS.perRecipientHour < 25)
  })
})
