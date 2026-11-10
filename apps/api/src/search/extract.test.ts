import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CHUNK_CHARS, MAX_CHUNKS, chunkText, stripConversionHeader, textKind, wellFormed } from './extract.ts'

describe('textKind', () => {
  it('reads PDFs, CSVs and text-like types, and nothing else', () => {
    assert.equal(textKind('application/pdf', 'a.pdf'), 'pdf')
    assert.equal(textKind('application/octet-stream', 'scan.PDF'), 'pdf')
    assert.equal(textKind('text/csv', 'x.csv'), 'csv')
    assert.equal(textKind('application/vnd.ms-excel', 'export.csv'), 'csv')
    assert.equal(textKind('text/markdown; charset=utf-8', 'notes.md'), 'text')
    assert.equal(textKind('application/json', 'a.json'), 'text')
    assert.equal(textKind('image/png', 'a.png'), null)
    assert.equal(textKind('application/zip', 'a.zip'), null)
  })
})

describe('stripConversionHeader', () => {
  it('drops the file name and metadata block toMarkdown puts before the pages', () => {
    const md = '# a.pdf\n## Metadata\n- Producer=Quartz\n- CreationDate=D:2026\n\n\n\n## Contents\n### Page 1\nHello\n'
    assert.equal(stripConversionHeader(md), '### Page 1\nHello\n')
  })
  it('leaves text without the header alone', () => {
    assert.equal(stripConversionHeader('## Contents\nno metadata'), '## Contents\nno metadata')
    assert.equal(stripConversionHeader('plain'), 'plain')
  })
})

describe('chunkText', () => {
  it('keeps a short text as one chunk', () => {
    assert.deepEqual(chunkText('Hello\n\nWorld', 'text'), { chunks: ['Hello\n\nWorld'], truncated: false })
  })

  it('cuts prose on blank lines near the target size, repeating the tail of the previous chunk', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${'x'.repeat(400)}`)
    const { chunks, truncated } = chunkText(paragraphs.join('\n\n'), 'text')
    assert.equal(truncated, false)
    assert.ok(chunks.length >= 3, `got ${chunks.length} chunks`)
    for (const c of chunks) assert.ok(c.length <= CHUNK_CHARS * 1.5, `chunk of ${c.length}`)
    // The second chunk starts with the end of the first.
    const tail = chunks[0]!.slice(-50)
    assert.ok(chunks[1]!.startsWith(tail.slice(-50)) || chunks[1]!.includes(tail), 'no overlap')
    // Every paragraph is in some chunk, whole.
    for (const p of paragraphs) assert.ok(chunks.some((c) => c.includes(p)), `${p.slice(0, 12)} lost`)
  })

  it('cuts one huge paragraph hard', () => {
    const { chunks } = chunkText('y'.repeat(CHUNK_CHARS * 4), 'text')
    assert.ok(chunks.length >= 3)
    assert.ok(chunks.every((c) => c.length <= CHUNK_CHARS * 1.5))
  })

  it('repeats the CSV header in every chunk and never splits a row', () => {
    const header = 'id,name,amount'
    const rows = Array.from({ length: 300 }, (_, i) => `${i},item ${i},${i * 10}`)
    const { chunks } = chunkText([header, ...rows].join('\n'), 'csv')
    assert.ok(chunks.length > 1)
    for (const c of chunks) {
      const lines = c.split('\n')
      assert.equal(lines[0], header)
      for (const l of lines.slice(1)) assert.match(l, /^\d+,item \d+,\d+$/)
    }
    assert.equal(chunks.flatMap((c) => c.split('\n').slice(1)).length, rows.length)
  })

  it('stops at MAX_CHUNKS and says so', () => {
    const text = Array.from({ length: MAX_CHUNKS + 50 }, (_, i) => `P${i} ${'z'.repeat(CHUNK_CHARS)}`).join('\n\n')
    const { chunks, truncated } = chunkText(text, 'text')
    assert.equal(chunks.length, MAX_CHUNKS)
    assert.equal(truncated, true)
  })

  it('never cuts an emoji in half, wherever the cuts fall', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    // One long paragraph of emoji (two code units each), shifted so cuts land on every offset.
    for (const pad of ['', 'a', 'ab']) {
      const { chunks } = chunkText(pad + '😀'.repeat(CHUNK_CHARS * 2), 'text')
      assert.ok(chunks.length > 1)
      for (const c of chunks) assert.doesNotMatch(c, lone)
    }
    // And the overlap carried between paragraphs.
    const paragraphs = Array.from({ length: 20 }, (_, i) => `${'x'.repeat(i % 3)}${'🎉'.repeat(400)}`).join('\n\n')
    for (const c of chunkText(paragraphs, 'text').chunks) assert.doesNotMatch(c, lone)
  })
})

describe('wellFormed', () => {
  it('replaces halves of character pairs and keeps whole ones', () => {
    assert.equal(wellFormed('ok 😀'), 'ok 😀')
    assert.equal(wellFormed('a\uD83Db'), 'a\uFFFDb')
    assert.equal(wellFormed('\uDE00 end'), '\uFFFD end')
    // JSON.stringify of the result must parse back to itself, which is what Workers AI checks.
    const s = wellFormed('x\uD83D')
    assert.equal(JSON.parse(JSON.stringify(s)), s)
  })
})
