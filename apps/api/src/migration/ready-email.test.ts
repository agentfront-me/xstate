// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readyEmail } from './ready-email.ts'

const base = { url: 'https://go.xstate.com/migrate/', organization: 'Acme', domain: 'acme.com', adminName: 'Gia Admin', people: 7, messages: 12_400, contacts: 1, files: 52, attention: 0 }

describe('readyEmail', () => {
  it('names the domain and counts what was copied', () => {
    const e = readyEmail(base)
    assert.equal(e.subject, 'Your Google Workspace copy is ready (acme.com)')
    assert.match(e.text, /^Hi Gia,/)
    assert.match(e.text, /12,400 messages, 1 contact and 52 files for 7 people in Acme\./)
    assert.doesNotMatch(e.text, /attention/)
  })

  it('says how many need a fix first', () => {
    assert.match(readyEmail({ ...base, attention: 1 }).text, /1 person or shared drive needs your attention/)
    assert.match(readyEmail({ ...base, attention: 3 }).text, /3 people or shared drives need your attention/)
  })

  it('escapes names in the HTML', () => {
    const e = readyEmail({ ...base, organization: 'A&B <Co>' })
    assert.match(e.html, /A&amp;B &lt;Co&gt;/)
    assert.doesNotMatch(e.html, /<Co>/)
  })
})
