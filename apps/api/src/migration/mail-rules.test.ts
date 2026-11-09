// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { placement, rangeQuery } from './mail-rules.ts'

const labels = new Set(['Label_1', 'Label_2'])

describe('placement', () => {
  it('puts inbox mail in the inbox, read unless UNREAD, and drops tabs and IMPORTANT', () => {
    assert.deepEqual(placement(['INBOX', 'CATEGORY_SOCIAL', 'IMPORTANT'], labels), { folders: ['inbox'], keywords: ['$seen'] })
    assert.deepEqual(placement(['INBOX', 'UNREAD'], labels), { folders: ['inbox'], keywords: [] })
  })

  it('maps user labels to their folders, alongside system ones', () => {
    assert.deepEqual(placement(['INBOX', 'STARRED', 'Label_1'], labels), { folders: ['inbox', { label: 'Label_1' }], keywords: ['$seen', '$flagged'] })
    assert.deepEqual(placement(['Label_2'], labels), { folders: [{ label: 'Label_2' }], keywords: ['$seen'] })
  })

  it('archives mail with no folder label, including labels it doesn’t know', () => {
    assert.deepEqual(placement([], labels), { folders: ['archive'], keywords: ['$seen'] })
    assert.deepEqual(placement(['Label_9'], labels), { folders: ['archive'], keywords: ['$seen'] })
  })

  it('lets trash and spam win over other labels', () => {
    assert.deepEqual(placement(['TRASH', 'INBOX', 'Label_1'], labels), { folders: ['trash'], keywords: ['$seen'] })
    assert.deepEqual(placement(['SPAM', 'UNREAD'], labels), { folders: ['junk'], keywords: [] })
  })

  it('marks drafts and skips chats', () => {
    assert.deepEqual(placement(['DRAFT'], labels), { folders: ['drafts'], keywords: ['$seen', '$draft'] })
    assert.deepEqual(placement(['CHAT'], labels), { skip: 'chat' })
  })
})

describe('rangeQuery', () => {
  const now = new Date('2026-11-08T12:00:00Z')
  it('is empty for all mail and a Gmail "after:" search otherwise', () => {
    assert.equal(rangeQuery('all', now), undefined)
    assert.equal(rangeQuery('1y', now), 'after:2025/11/08')
    assert.equal(rangeQuery('5y', now), 'after:2021/11/08')
  })
})
