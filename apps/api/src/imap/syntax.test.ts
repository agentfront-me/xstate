import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextCommand, parseSet, pick } from './syntax.ts'

const bytes = (s: string) => new TextEncoder().encode(s)
const command = (s: string) => {
  const next = nextCommand(bytes(s))
  assert.equal(next.kind, 'command', JSON.stringify(next))
  return next.kind === 'command' ? next : (null as never)
}

test('a simple command, and what is left for the next', () => {
  const next = command('a1 select INBOX\r\na2 NOOP\r\n')
  assert.deepEqual(next.command, { tag: 'a1', name: 'SELECT', args: [{ t: 'atom', v: 'INBOX' }] })
  assert.equal(next.consumed, 17)
})

test('half a command waits for more', () => {
  assert.deepEqual(nextCommand(bytes('a1 SELECT INB')), { kind: 'more' })
})

test('quoted strings, escapes and UTF-8', () => {
  const { args } = command('a LOGIN "me@x.test" "pa\\"ss wörd"\r\n').command
  assert.deepEqual(args, [{ t: 'string', v: 'me@x.test' }, { t: 'string', v: 'pa"ss wörd' }])
})

test('a fetch with a section keeps its brackets and list together', () => {
  const { args } = command('a UID FETCH 1:* (UID FLAGS BODY.PEEK[HEADER.FIELDS (From To)]<0.10>)\r\n').command
  assert.deepEqual(args, [
    { t: 'atom', v: 'FETCH' },
    { t: 'atom', v: '1:*' },
    { t: 'list', items: [{ t: 'atom', v: 'UID' }, { t: 'atom', v: 'FLAGS' }, { t: 'atom', v: 'BODY.PEEK[HEADER.FIELDS (From To)]<0.10>' }] },
  ])
})

test('a literal is asked for, then read', () => {
  const first = nextCommand(bytes('a LOGIN {9}\r\n'))
  assert.deepEqual(first, { kind: 'literal', size: 9, sync: true, announcedAt: 13 })
  assert.equal(nextCommand(bytes('a LOGIN {9+}\r\nme@x')).kind, 'literal')
  const { command: c, consumed } = command('a LOGIN {9}\r\nme@x.test {4}\r\nab d\r\nb NOOP\r\n')
  assert.deepEqual(c.args.map((a) => (a.t === 'string' ? a.v : null)), ['me@x.test', 'ab d'])
  assert.deepEqual(c.args[1], { t: 'string', v: 'ab d', raw: bytes('ab d') })
  assert.equal(consumed, 'a LOGIN {9}\r\nme@x.test {4}\r\nab d\r\n'.length)
})

test('bad syntax names the tag and skips the line', () => {
  const next = nextCommand(bytes('a7 SEARCH (FROM x\r\nb NOOP\r\n'))
  assert.equal(next.kind, 'bad')
  assert.equal(next.kind === 'bad' && next.tag, 'a7')
  assert.equal(next.kind === 'bad' && next.consumed, 19)
  assert.equal(nextCommand(bytes('a8 APPEND INBOX {99999999}\r\n')).kind, 'bad')
  // A message being saved may be larger than a name or a search word.
  assert.equal(nextCommand(bytes('a8 APPEND INBOX {2000000}\r\n'), 40_000_000).kind, 'literal')
})

test('sequence sets', () => {
  assert.deepEqual(parseSet('1:3,7,10:*'), [[1, 3], [7, 7], [10, Infinity]])
  assert.deepEqual(parseSet('*:4'), [[4, Infinity]])
  assert.equal(parseSet('1:x'), null)
  assert.equal(parseSet('0'), null)
  const uids = [2, 4, 6, 8, 10]
  assert.deepEqual(pick(parseSet('1:5,8')!, uids), [2, 4, 8])
  assert.deepEqual(pick(parseSet('9:*')!, uids), [10])
  assert.deepEqual(pick(parseSet('50:*')!, uids), [10])
  assert.deepEqual(pick(parseSet('*')!, uids), [10])
  assert.deepEqual(pick(parseSet('1:*')!, []), [])
})
