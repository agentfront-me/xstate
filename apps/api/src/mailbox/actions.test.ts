// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planUpdate, type UpdateRow } from './actions.ts'

const rows: UpdateRow[] = [
  { n: 1, id: 'a', folder: 'inbox', seen: false, pinned: false },
  { n: 2, id: 'b', folder: 'sent', seen: true, pinned: false },
  { n: 3, id: 'c', folder: 'inbox', seen: false, pinned: true },
]

describe('planUpdate', () => {
  it('changes only the chosen message without thread', () => {
    assert.deepEqual(planUpdate(rows, { id: 'a', seen: true }), [{ n: 1, seen: true }])
  })

  it('marks the whole conversation read with thread, skipping messages already read', () => {
    assert.deepEqual(planUpdate(rows, { id: 'a', seen: true, thread: true }), [
      { n: 1, seen: true },
      { n: 3, seen: true },
    ])
  })

  it('archives only the conversation messages in the chosen one\'s folder', () => {
    assert.deepEqual(planUpdate(rows, { id: 'c', folder: 'archive', thread: true }), [
      { n: 1, folder: 'archive' },
      { n: 3, folder: 'archive' },
    ])
  })

  it('pins only the chosen message, even with thread', () => {
    assert.deepEqual(planUpdate(rows, { id: 'a', pinned: true, thread: true }), [{ n: 1, pinned: true }])
  })

  it('leaves out what already matches, and a move to the folder it is in', () => {
    assert.deepEqual(planUpdate(rows, { id: 'b', seen: true, folder: 'sent' }), [])
  })

  it('combines changes on one message', () => {
    assert.deepEqual(planUpdate(rows, { id: 'a', seen: true, pinned: true, folder: 'trash' }), [
      { n: 1, seen: true, pinned: true, folder: 'trash' },
    ])
  })

  it('is null when the message is not there', () => {
    assert.equal(planUpdate(rows, { id: 'z', seen: true }), null)
  })
})
