// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decodeEntities, htmlToText } from './html-text.ts'

describe('decodeEntities', () => {
  it('decodes numeric references, decimal and hex', () => {
    assert.equal(decodeEntities('a&#847;b &#x2019;s &#X2019;'), 'a\u034fb ’s ’')
  })
  it('decodes the common named ones and leaves unknown names alone', () => {
    assert.equal(decodeEntities('&lt;b&gt; &amp;amp; &copy; &mdash; &unknownthing;'), '<b> &amp; © — &unknownthing;')
  })
  it('turns references that are not characters into the replacement character', () => {
    assert.equal(decodeEntities('&#0; &#xD800; &#1114112;'), '\ufffd \ufffd \ufffd')
  })
})

describe('htmlToText', () => {
  it('keeps paragraphs and line breaks, and drops scripts, styles and tags', () => {
    const html = '<html><head><title>x</title></head><style>p{}</style><body><p>Hello&nbsp;there</p><p>Second<br>line</p><script>bad()</script></body></html>'
    assert.equal(htmlToText(html), 'Hello there\nSecond\nline')
  })
  it('decodes after removing tags, so an escaped tag stays text', () => {
    assert.equal(htmlToText('<p>Use &lt;b&gt; for bold &#8212; done</p>'), 'Use <b> for bold — done')
  })
})
