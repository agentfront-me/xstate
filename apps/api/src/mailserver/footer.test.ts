// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { previewText, stripFooter } from './footer.ts'

// The shape of a Wave invoice email, as the HireNinja mailbox has hundreds of.
const wave = [
  'HireNinja has sent you an invoice for',
  '$11,200.00',
  'Due on Aug 04, 2023',
  'For questions about this invoice, please contact asif@example.com',
  'HireNinja',
  'Islamabad',
  'Powered by',
  '© 2010-2023 Wave Financial USA Inc. and Wave Financial Inc. All Rights Reserved.  Privacy Policy  •  Terms of Use',
].join('\n')

describe('stripFooter', () => {
  it('cuts a sender footer from "Powered by" or "©" near the end', () => {
    const out = stripFooter(wave)
    assert.match(out, /\$11,200\.00/)
    assert.doesNotMatch(out, /Powered by|©|Privacy Policy|Rights Reserved/)
  })

  it('drops lines that are only unsubscribe or legal links, wherever they are', () => {
    const out = stripFooter('Hello Jane,\n\nUnsubscribe • Privacy Policy\n\nThe report is attached.\nView this email in your browser')
    assert.equal(out, 'Hello Jane,\n\nThe report is attached.')
  })

  it('keeps sentences that only mention those words', () => {
    const text = 'Please read our new privacy policy before Friday, it changes how we store invoices.'
    assert.equal(stripFooter(text), text)
  })

  it('keeps a "©" far above the end: it is part of the message', () => {
    const body = `The logo must show © 2024 Acme.\n${'More text about the brand guidelines. '.repeat(20)}`
    assert.match(stripFooter(body), /© 2024 Acme/)
  })

  it('keeps a short text that opens with "©"', () => {
    assert.equal(stripFooter('© 2024 Acme'), '© 2024 Acme')
  })
})

describe('previewText', () => {
  it('is one line without the footer', () => {
    assert.equal(
      previewText(wave, 300),
      'HireNinja has sent you an invoice for $11,200.00 Due on Aug 04, 2023 For questions about this invoice, please contact asif@example.com HireNinja Islamabad',
    )
  })

  it('cuts at a word and marks the cut', () => {
    const out = previewText('one two three four five six seven', 20)
    assert.equal(out, 'one two three four…')
  })
})
