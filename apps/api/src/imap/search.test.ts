import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDate, parseSearch, resolveSequences, searchSql } from './search.ts'
import { tokenize } from './syntax.ts'

const parse = (s: string) => parseSearch(tokenize([{ text: s }]))

test('dates', () => {
  assert.equal(parseDate('2-Nov-2026'), Date.UTC(2026, 10, 2) / 1000)
  assert.equal(parseDate('2026-11-02'), null)
})

test('what mail apps send', () => {
  assert.deepEqual(parse('UNSEEN'), { k: 'not', c: { k: 'flag', flag: 'seen' } })
  assert.deepEqual(parse('UID 1:* NOT DELETED'), { k: 'and', list: [{ k: 'uid', set: [[1, Infinity]] }, { k: 'not', c: { k: 'flag', flag: 'deleted' } }] })
  assert.deepEqual(parse('CHARSET UTF-8 OR FROM "ann" SUBJECT "invoice"'), {
    k: 'or',
    a: { k: 'text', field: 'from', value: 'ann' },
    b: { k: 'text', field: 'subject', value: 'invoice' },
  })
  assert.deepEqual(parse('SINCE 1-Nov-2026 (LARGER 1000 HEADER Message-ID "<a@b>")'), {
    k: 'and',
    list: [
      { k: 'date', op: 'since', day: Date.UTC(2026, 10, 1) / 1000 },
      { k: 'and', list: [{ k: 'size', op: 'larger', n: 1000 }, { k: 'text', field: 'message-id', value: 'a@b' }] },
    ],
  })
  assert.deepEqual(parse('1:3,9'), { k: 'seq', set: [[1, 3], [9, 9]] })
})

test('mistakes are refused with a reason', () => {
  assert.throws(() => parse('FROM'), /missing its value/)
  assert.throws(() => parse('SINCE yesterday'), /date/)
  assert.throws(() => parse('SHINY'), /Unknown search key SHINY/)
  assert.throws(() => parse('CHARSET KOI8-R ALL'), /BADCHARSET/)
})

test('sequence numbers become UIDs before the store is asked', () => {
  const resolved = resolveSequences(parse('NOT 1:2'), () => [10, 20])
  assert.deepEqual(resolved, { k: 'not', c: { k: 'uid', set: [[10, 10], [20, 20]] } })
  assert.deepEqual(resolveSequences(parse('5'), () => []), { k: 'none' })
})

test('SQL', () => {
  assert.deepEqual(searchSql(parse('UNSEEN SINCE 1-Nov-2026')), { sql: '((NOT (m.seen = 1)) AND (m.received_s >= ?))', params: [Date.UTC(2026, 10, 1) / 1000] })
  assert.deepEqual(searchSql(parse('UID 5:*')), { sql: '(p.uid BETWEEN ? AND ?)', params: [5, 4294967295] })
  assert.deepEqual(searchSql(parse('BODY "quarterly report"')), { sql: 'm.n IN (SELECT rowid FROM text_fts WHERE text_fts MATCH ?)', params: ['"quarterly" AND "report"'] })
  assert.deepEqual(searchSql(parse('OR SEEN FLAGGED')), { sql: '((m.seen = 1) OR (m.pinned = 1))', params: [] })
  assert.equal(searchSql(parse('FROM "o\'brien"')).params[0], "o'brien")
})
