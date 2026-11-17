// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseDifferences, readableText } from './compare.ts'

const base = { subject: 'Invoice 314', from: [{ name: 'HireNinja', email: 'mailer@waveapps.com' }], to: [{ name: null, email: 'asif@example.test' }], text: 'Hello\n\nthere' }

describe('parseDifferences', () => {
  it('finds none when only whitespace, address case, names or order differ', () => {
    const theirs = { subject: ' Invoice  314 ', from: [{ name: null, email: 'Mailer@WaveApps.com' }], to: base.to, text: 'Hello there\n' }
    assert.deepEqual(parseDifferences(base, theirs), [])
  })

  it('names each field that differs', () => {
    const theirs = { subject: 'Invoice 315', from: [{ name: null, email: 'other@waveapps.com' }], to: [], text: 'Goodbye' }
    assert.deepEqual(parseDifferences(base, theirs), ['subject', 'from', 'to', 'text'])
  })

  it('compares only the start of long text', () => {
    const long = 'word '.repeat(1000)
    assert.deepEqual(parseDifferences({ ...base, text: `${long} ours` }, { ...base, text: `${long} theirs` }), [])
  })
})

describe('parseDifferences on real mail', () => {
  it('ignores invisible padding characters, which parsers break up differently', () => {
    const ours = { ...base, text: 'Share and earn.\u200b\u200b\u200b\u200c\u200c rest' }
    const theirs = { ...base, text: 'Share and earn.\u200b\u200b \u200b\u200c\u200c rest' }
    assert.deepEqual(parseDifferences(ours, theirs), [])
  })
})

describe('readableText', () => {
  const fromHtml = (h: string) => h.replace(/<[^>]+>/g, '')
  it('uses the plain-text part when it has text', () => {
    assert.equal(readableText('Plain', '<p>Html</p>', fromHtml), 'Plain')
  })
  it('falls back to the HTML part when the plain part is empty or blank', () => {
    assert.equal(readableText('', '<p>Html</p>', fromHtml), 'Html')
    assert.equal(readableText(' \r\n', '<p>Html</p>', fromHtml), 'Html')
    assert.equal(readableText(undefined, '<p>Html</p>', fromHtml), 'Html')
  })
  it('is empty when there is neither', () => {
    assert.equal(readableText(undefined, undefined, fromHtml), '')
  })
})
