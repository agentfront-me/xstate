// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { addressText, fromSeconds, headerMatch, listSql, rowToList, senderParts, toSeconds, wordMatch, type StoreFolder, type StoreRow } from './query.ts'

const folders: StoreFolder[] = [
  { id: 'a', role: 'inbox', name: 'Inbox' },
  { id: 'h', role: 'archive', name: 'Archive' },
  { id: 'c', role: 'junk', name: 'Junk Mail' },
  { id: 'b', role: 'trash', name: 'Deleted Items' },
  { id: 'x', role: null, name: 'Projects' },
]

describe('senderParts', () => {
  it('lowercases the address and splits off the domain', () => {
    assert.deepEqual(senderParts([{ name: 'HireNinja', email: 'Mailer@WaveApps.com' }]), { addr: 'mailer@waveapps.com', domain: 'waveapps.com', name: 'HireNinja' })
  })
  it('copes with no sender', () => {
    assert.deepEqual(senderParts([]), { addr: '', domain: '', name: '' })
  })
})

describe('times', () => {
  it('round-trips the mail server form, without milliseconds', () => {
    assert.equal(fromSeconds(toSeconds('2023-12-15T10:24:28Z')), '2023-12-15T10:24:28Z')
  })
})

describe('wordMatch', () => {
  it('asks for every word, each as its own term, since the index keeps no positions', () => {
    assert.equal(wordMatch('Invoice INV-4566 overdue'), '"invoice" "inv" "4566" "overdue"')
  })
  it('keeps letters of any language and drops repeats', () => {
    assert.equal(wordMatch('Café café 日本'), '"café" "日本"')
  })
  it('is null when there is nothing to search for', () => {
    assert.equal(wordMatch(' -- "" '), null)
  })
})

describe('headerMatch', () => {
  it('is a quoted substring, in one column or any', () => {
    assert.equal(headerMatch('sender', 'waveapps.com'), 'sender : "waveapps.com"')
    assert.equal(headerMatch(null, ' waveapps '), '"waveapps"')
  })
  it('doubles quotes so the value cannot break out of the phrase', () => {
    assert.equal(headerMatch('subject', 'say "hi" OR x'), 'subject : "say ""hi"" OR x"')
  })
  it('is null under three characters, where trigrams cannot match', () => {
    assert.equal(headerMatch('sender', 'ab'), null)
  })
})

describe('listSql', () => {
  it('reads one folder through the placements index', () => {
    const q = listSql({ folder: 'inbox', limit: 50 }, folders, 100)!
    assert.match(q.sql, /FROM placements p JOIN messages m ON m\.n = p\.n WHERE p\.folder_id = \? ORDER BY p\.received_s DESC, p\.n DESC LIMIT \?/)
    assert.deepEqual(q.params, ['a', 100])
  })

  it('has nothing to list when the mailbox has no folder with that role', () => {
    assert.equal(listSql({ folder: 'drafts', limit: 50 }, folders, 100), null)
  })

  it('leaves junk and trash out of "all" and "pinned"', () => {
    const all = listSql({ folder: 'all', limit: 10 }, folders, 20)!
    assert.match(all.sql, /FROM messages m WHERE EXISTS \(SELECT 1 FROM placements p WHERE p\.n = m\.n AND p\.folder_id NOT IN \(\?, \?\)\) ORDER BY m\.received_s DESC/)
    assert.deepEqual(all.params, ['c', 'b', 20])
    assert.match(listSql({ folder: 'pinned', limit: 10 }, folders, 20)!.sql, /AND m\.pinned = 1/)
  })

  it('filters a sender by part of the address through the trigram index', () => {
    const q = listSql({ folder: 'all', from: 'waveapps.com', limit: 10 }, [], 20)!
    assert.match(q.sql, /m\.n IN \(SELECT rowid FROM headers_fts WHERE headers_fts MATCH \?\)/)
    assert.deepEqual(q.params, ['sender : "waveapps.com"', 20])
  })

  it('falls back to LIKE for a value too short for trigrams, escaping wildcards', () => {
    const q = listSql({ folder: 'all', subject: 'a%', limit: 10 }, [], 20)!
    assert.match(q.sql, /m\.subject LIKE \? ESCAPE/)
    assert.deepEqual(q.params, ['%a\\%%', 20])
  })

  it('searches text as words in the body or as part of a header', () => {
    const q = listSql({ folder: 'all', text: 'waveapps.com', limit: 10 }, [], 20)!
    assert.match(q.sql, /\(m\.n IN \(SELECT rowid FROM text_fts WHERE text_fts MATCH \?\) OR m\.n IN \(SELECT rowid FROM headers_fts WHERE headers_fts MATCH \?\)\)/)
    assert.deepEqual(q.params, ['"waveapps" "com"', '"waveapps.com"', 20])
  })

  it('matches nothing for text with nothing searchable in it', () => {
    assert.match(listSql({ folder: 'all', text: '--', limit: 10 }, [], 20)!.sql, /WHERE 0 /)
  })

  it('applies dates, flags and the page start', () => {
    const q = listSql(
      { folder: 'all', unreadOnly: true, hasAttachment: true, after: '2023-01-01T00:00:00Z', before: '2024-01-01T00:00:00.000Z', limit: 10 },
      [],
      20,
      { receivedS: 1700000000, n: 42 },
    )!
    assert.match(q.sql, /m\.seen = 0 AND m\.has_attachment = 1 AND m\.received_s >= \? AND m\.received_s < \? AND \(m\.received_s < \? OR \(m\.received_s = \? AND m\.n < \?\)\)/)
    assert.deepEqual(q.params, [1672531200, 1704067200, 1700000000, 1700000000, 42, 20])
  })
})

describe('rowToList', () => {
  it('turns a row back into the message', () => {
    const row: StoreRow = {
      n: 1, id: 'm1', thread_id: 't1', folder: 'archive', seen: 1, pinned: 0, from_json: '[{"name":"A","email":"a@x.com"}]', to_json: '[]',
      subject: 'Hi', preview: 'Hello', received_s: 1702635868, size: 10, has_attachment: 1,
    }
    assert.deepEqual(rowToList(row, 3), {
      id: 'm1', threadId: 't1', folder: 'archive', seen: true, pinned: false, from: [{ name: 'A', email: 'a@x.com' }], to: [],
      subject: 'Hi', preview: 'Hello', receivedAt: '2023-12-15T10:24:28Z', size: 10, hasAttachment: true, threadSize: 3,
    })
    assert.equal(addressText([{ name: 'A', email: 'a@x.com' }, { name: null, email: 'b@y.com' }]), 'A a@x.com b@y.com')
  })
})
