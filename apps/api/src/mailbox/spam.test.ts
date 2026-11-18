// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideSpam, type SpamInput } from './spam.ts'

const clean: SpamInput = {
  ses: { spam: 'PASS', spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
  dmarcPolicy: null,
  from: { name: 'Jane Customer', email: 'jane@example.org' },
  replyTo: [],
  senderVerdict: null,
  known: false,
  orgDomains: ['99events.com'],
  orgNames: ['Asif Khan', '99events'],
}

describe('decideSpam', () => {
  it('lets clean mail into the Inbox', () => {
    assert.deepEqual(decideSpam(clean), { folder: 'inbox', score: 0, reasons: [] })
  })

  it('still sends SES spam to Junk on its own, as before', () => {
    const d = decideSpam({ ...clean, ses: { ...clean.ses, spam: 'FAIL' } })
    assert.equal(d.folder, 'junk')
    assert.equal(d.score, 5)
  })

  it('follows the mailbox\'s own verdict first, whatever else is true', () => {
    assert.equal(decideSpam({ ...clean, ses: { ...clean.ses, spam: 'FAIL' }, senderVerdict: 'notjunk' }).folder, 'inbox')
    assert.equal(decideSpam({ ...clean, known: true, senderVerdict: 'junk' }).folder, 'junk')
  })

  it('sends failed DMARC to Junk when the domain asks for reject or quarantine, even from someone known', () => {
    const forged = { ...clean, known: true, ses: { ...clean.ses, dmarc: 'FAIL' }, dmarcPolicy: 'reject' }
    const d = decideSpam(forged)
    assert.equal(d.folder, 'junk')
    assert.match(d.reasons[0]!, /asks for reject/)
    assert.equal(decideSpam({ ...forged, dmarcPolicy: 'quarantine' }).folder, 'junk')
  })

  it('trusts a known sender over SES\'s spam verdict, when authentication holds', () => {
    const d = decideSpam({ ...clean, known: true, ses: { ...clean.ses, spam: 'FAIL' } })
    assert.deepEqual(d, { folder: 'inbox', score: 0, reasons: ['Known sender'] })
  })

  it('doesn\'t trust a known sender whose DMARC fails, even with policy none', () => {
    const d = decideSpam({ ...clean, known: true, ses: { ...clean.ses, dmarc: 'FAIL', spam: 'FAIL' }, dmarcPolicy: 'none' })
    assert.equal(d.folder, 'junk')
    assert.equal(d.score, 7)
  })

  it('catches a colleague\'s name from outside the organization', () => {
    const d = decideSpam({ ...clean, from: { name: 'Asif  KHAN', email: 'asif.ceo@gmail.com' } })
    assert.equal(d.folder, 'junk')
    assert.match(d.reasons[0]!, /Uses the name/)
  })

  it('allows that name from the organization\'s own domain', () => {
    assert.equal(decideSpam({ ...clean, from: { name: 'Asif Khan', email: 'asif@99events.com' } }).folder, 'inbox')
  })

  it('lets weak signals tip only mail with other problems', () => {
    const weak = { ...clean, ses: { ...clean.ses, spf: 'FAIL', dkim: 'FAIL' }, replyTo: ['pay@other.example'] }
    assert.deepEqual(decideSpam(weak), { folder: 'inbox', score: 4, reasons: ['SPF and DKIM both failed (+3)', 'Reply-To goes to another domain (+1)'] })
    assert.equal(decideSpam({ ...weak, ses: { ...weak.ses, dmarc: 'FAIL' }, dmarcPolicy: 'none' }).folder, 'junk')
  })

  it('ignores a Reply-To on the same domain', () => {
    assert.equal(decideSpam({ ...clean, replyTo: ['billing@example.org'] }).score, 0)
  })
})
