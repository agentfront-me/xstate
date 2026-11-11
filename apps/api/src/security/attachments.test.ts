// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { checkHead, checkName, decodeSafety, encodeSafety, executableKind, inspect, inspectStream, zipEntries } from './attachments.ts'

const enc = (s: string) => new TextEncoder().encode(s)

/** A minimal Windows program header: MZ, e_lfanew at 0x3c pointing at "PE\0\0". */
function pe(): Uint8Array {
  const b = new Uint8Array(256)
  b.set([0x4d, 0x5a])
  b[0x3c] = 0x80
  b.set([0x50, 0x45, 0, 0], 0x80)
  return b
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const out = await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()
  return new Uint8Array(out)
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const out = await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
  return new Uint8Array(out)
}

type Entry = { name: string; data: Uint8Array; deflated?: boolean; encrypted?: boolean }

/** Builds a zip archive (no CRCs: the reader doesn't check them). */
async function zip(entries: Entry[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc(e.name)
    const body = e.deflated ? await deflate(e.data) : e.data
    const flags = (e.encrypted ? 1 : 0) | 0x800
    const method = e.deflated ? 8 : 0
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(6, flags, true)
    lv.setUint16(8, method, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, e.data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(8, flags, true)
    cv.setUint16(10, method, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, e.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cd.set(name, 46)
    parts.push(local, body)
    central.push(cd)
    offset += local.length + body.length
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  return join([...parts, ...central, end])
}

function tar(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const e of entries) {
    const h = new Uint8Array(512)
    h.set(enc(e.name).subarray(0, 100))
    h.set(enc(e.data.length.toString(8).padStart(11, '0')), 124)
    h.set(enc('0'), 156)
    h.set(enc('ustar'), 257)
    blocks.push(h)
    const padded = new Uint8Array(Math.ceil(e.data.length / 512) * 512)
    padded.set(e.data)
    blocks.push(padded)
  }
  blocks.push(new Uint8Array(1024))
  return join(blocks)
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const stream = (b: Uint8Array) => new Blob([b]).stream()

describe('checkName', () => {
  it('allows ordinary documents', () => {
    for (const name of ['report.pdf', 'Q3 numbers.xlsx', 'photo.JPG', 'notes', 'archive.zip', '.env.example']) {
      assert.equal(checkName(name).level, 'ok', name)
    }
  })
  it('blocks programs and scripts, in any case and with trailing spaces', () => {
    for (const name of ['setup.exe', 'INVOICE.PDF.EXE', 'run.js', 'a.vbs', 'shortcut.lnk', 'disk.iso', 'x.ps1', 'app.msi', 'invoice.pdf   .scr  ']) {
      const v = checkName(name)
      assert.equal(v.level, 'blocked', name)
      assert.equal(v.code, 'blocked_type')
    }
  })
  it('blocks names that hide their extension with direction marks', () => {
    const v = checkName('invoice‮fdp.exe')
    assert.equal(v.level, 'blocked')
    assert.equal(v.code, 'hidden_extension')
    assert.equal(checkName('report‮txt.pdf').code, 'hidden_extension')
  })
  it('warns on macro Office files and archives it cannot open', () => {
    assert.equal(checkName('budget.xlsm').code, 'macros')
    assert.equal(checkName('budget.xlsm').level, 'warn')
    assert.equal(checkName('files.7z').code, 'unchecked_archive')
    assert.equal(checkName('files.rar').level, 'warn')
  })
})

describe('executableKind', () => {
  it('finds Windows programs by the PE header', () => {
    assert.equal(executableKind(pe()), 'a Windows program')
  })
  it('does not flag text that happens to start with MZ', () => {
    assert.equal(executableKind(enc('MZ,Name,Amount\nMZ1,Alice,10\n'.repeat(10))), null)
  })
  it('finds Linux and Mac programs, shortcuts and disk images', () => {
    assert.equal(executableKind(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1])), 'a Linux program')
    assert.equal(executableKind(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7, 0])), 'a Mac or Java program')
    assert.equal(executableKind(new Uint8Array([0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0])), 'a Windows shortcut')
    const iso = new Uint8Array(0x8010)
    iso.set(enc('CD001'), 0x8001)
    assert.equal(executableKind(iso), 'a disk image')
  })
  it('leaves PDFs and images alone', () => {
    assert.equal(executableKind(enc('%PDF-1.7\n')), null)
    assert.equal(executableKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null)
  })
})

describe('checkHead', () => {
  it('blocks a program whatever its name says', () => {
    const v = checkHead(pe(), 'invoice.pdf')
    assert.equal(v.level, 'blocked')
    assert.equal(v.code, 'executable')
  })
})

describe('inspect: archives', () => {
  it('allows a zip of documents', async () => {
    const z = await zip([{ name: 'a.pdf', data: enc('%PDF-1.4') }, { name: 'dir/b.txt', data: enc('hello'), deflated: true }])
    assert.deepEqual(zipEntries(z)!.map((e) => e.name), ['a.pdf', 'dir/b.txt'])
    assert.equal((await inspect(z, 'docs.zip')).level, 'ok')
  })
  it('blocks a zip with a program inside, by name', async () => {
    const z = await zip([{ name: 'readme.txt', data: enc('hi') }, { name: 'tools/setup.exe', data: enc('x') }])
    const v = await inspect(z, 'docs.zip')
    assert.equal(v.code, 'blocked_in_archive')
    assert.match(v.message!, /setup\.exe/)
  })
  it('blocks a program renamed to look like a document inside a zip', async () => {
    const z = await zip([{ name: 'invoice.pdf', data: pe(), deflated: true }])
    assert.equal((await inspect(z, 'invoice.zip')).code, 'blocked_in_archive')
  })
  it('opens nested zips', async () => {
    const inner = await zip([{ name: 'payload.js', data: enc('alert(1)') }])
    const outer = await zip([{ name: 'inner.zip', data: inner, deflated: true }])
    assert.equal((await inspect(outer, 'outer.zip')).code, 'blocked_in_archive')
  })
  it('warns on password-protected zips, but still blocks by entry name', async () => {
    const locked = await zip([{ name: 'data.csv', data: enc('????'), encrypted: true }])
    assert.equal((await inspect(locked, 'data.zip')).code, 'encrypted_archive')
    const lockedExe = await zip([{ name: 'data.exe', data: enc('????'), encrypted: true }])
    assert.equal((await inspect(lockedExe, 'data.zip')).code, 'blocked_in_archive')
  })
  it('warns on Office files with a VBA project, whatever the extension', async () => {
    const docx = await zip([{ name: '[Content_Types].xml', data: enc('<x/>') }, { name: 'word/vbaProject.bin', data: enc('vba') }])
    assert.equal((await inspect(docx, 'letter.docx')).code, 'macros')
  })
  it('warns on old Office files with macros', async () => {
    const ole = new Uint8Array(2048)
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    ole.set(new Uint8Array([...'_VBA_PROJECT'].flatMap((c) => [c.charCodeAt(0), 0])), 1024)
    assert.equal((await inspect(ole, 'old.xls')).code, 'macros')
    const clean = new Uint8Array(2048)
    clean.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    assert.equal((await inspect(clean, 'old.xls')).level, 'ok')
  })
  it('reads tar and tar.gz', async () => {
    const t = tar([{ name: 'src/main.c', data: enc('int main(){}') }, { name: 'bin/run.bat', data: enc('echo') }])
    assert.equal((await inspect(t, 'src.tar')).code, 'blocked_in_archive')
    assert.equal((await inspect(await gzip(t), 'src.tar.gz')).code, 'blocked_in_archive')
    const ok = tar([{ name: 'notes.md', data: enc('# hi') }])
    assert.equal((await inspect(await gzip(ok), 'notes.tgz')).level, 'ok')
  })
  it('blocks a gzipped program', async () => {
    assert.equal((await inspect(await gzip(pe()), 'update.gz')).code, 'blocked_in_archive')
  })
})

describe('inspectStream', () => {
  it('passes the same bytes on', async () => {
    const data = new Uint8Array(200_000).map((_, i) => i % 251)
    const { safety, body } = await inspectStream(stream(data), 'data.bin')
    assert.equal(safety.level, 'ok')
    assert.deepEqual(new Uint8Array(await new Response(body).arrayBuffer()), data)
  })
  it('judges archives in full and still passes them on', async () => {
    const z = await zip([{ name: 'x.vbs', data: enc('x') }])
    const { safety, body } = await inspectStream(stream(z), 'x.zip')
    assert.equal(safety.code, 'blocked_in_archive')
    assert.equal((await new Response(body).arrayBuffer()).byteLength, z.length)
  })
})

describe('stored verdicts', () => {
  it('round-trips', () => {
    assert.equal(encodeSafety({ level: 'ok' }), 'ok')
    assert.equal(encodeSafety(checkName('a.exe')), 'blocked:blocked_type')
    assert.equal(decodeSafety('warn:macros', 'a.xls').code, 'macros')
    assert.match(decodeSafety('blocked:blocked_type', 'a.exe').message!, /\.exe/)
    assert.equal(decodeSafety(null, 'a.exe').level, 'blocked')
    assert.equal(decodeSafety('ok', 'a.exe').level, 'ok')
  })
})
