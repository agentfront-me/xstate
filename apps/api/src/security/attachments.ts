// File-type rules for mail attachments: which files are blocked, which get a warning, and why.
//
// Three layers, cheapest first:
//   1. The name: extensions that run code when opened (.exe, .js, .lnk, .iso…) are blocked, as are names that use
//      Unicode direction marks to hide their real extension ("invoice‮fdp.exe" shows as "invoiceexe.pdf").
//   2. The bytes: programs are blocked whatever they're called (Windows PE, ELF, Mach-O, shortcuts, disk images).
//   3. Inside archives: zip files (and Office files, which are zips) are listed entry by entry, nested archives are
//      opened too, and gzip/tar are read the same way. Password-protected archives and formats we can't read
//      (7z, rar) get a warning, since nothing inside them could be checked.
//
// Macros (Office files that can run code) get a warning, not a block: businesses still send macro spreadsheets.
// This is not a virus scanner; it removes the file types malware mostly travels in. See docs/security.md.
//
// Pure functions only (no env, no I/O), so it runs in tests, the API and the mail sync alike.

export type SafetyLevel = 'ok' | 'warn' | 'blocked'
export type SafetyCode =
  | 'blocked_type'
  | 'hidden_extension'
  | 'executable'
  | 'blocked_in_archive'
  | 'macros'
  | 'encrypted_archive'
  | 'unchecked_archive'

export type Safety = { level: SafetyLevel; code?: SafetyCode; message?: string }

export const SAFE: Safety = { level: 'ok' }

/** Run code when opened on Windows, macOS or in a browser/JVM. The same idea as Gmail's list, plus a few more. */
export const BLOCKED_EXTENSIONS = new Set([
  'ade', 'adp', 'apk', 'app', 'application', 'appref-ms', 'appx', 'appxbundle', 'bat', 'cab', 'chm', 'cmd', 'com',
  'command', 'cpl', 'diagcab', 'diagcfg', 'diagpkg', 'dll', 'dmg', 'ex_', 'exe', 'gadget', 'hta', 'img', 'inf', 'ins',
  'iso', 'isp', 'jar', 'jnlp', 'js', 'jse', 'lib', 'library-ms', 'lnk', 'mde', 'mjs', 'msc', 'msi', 'msix',
  'msixbundle', 'msp', 'mst', 'nsh', 'pif', 'pkg', 'ps1', 'ps1xml', 'ps2', 'psc1', 'psd1', 'psm1', 'reg', 'scf',
  'scr', 'sct', 'settingcontent-ms', 'shb', 'sys', 'url', 'vb', 'vbe', 'vbs', 'vhd', 'vhdx', 'vxd', 'wsc', 'wsf',
  'wsh', 'xbap', 'xll',
])

/** Office formats whose whole point is macros. */
const MACRO_EXTENSIONS = new Set(['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm'])

/** Archives we can't list. Their contents go unchecked, so they get a warning. */
const OPAQUE_ARCHIVES = new Set(['7z', 'rar', 'arj', 'ace', 'lzh', 'cpio', 'xz', 'bz2', 'zst'])

/** Bidi controls: they reorder how a name displays, which hides the real extension. */
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏؜]/

/** Bytes read from the start of every file for the program checks (ISO 9660's mark sits at 32 KB). */
export const HEAD_BYTES = 64 * 1024
/** Largest file read in full to look inside (archives, old Office files). Bigger ones get a warning. */
export const MAX_INSPECT_BYTES = 32 * 1024 * 1024
/** Nested archives opened, at most this deep and this large each once decompressed. */
const MAX_DEPTH = 3
const MAX_NESTED_BYTES = 16 * 1024 * 1024
/** Entries whose first bytes are decompressed and checked, per archive. */
const MAX_SNIFFED_ENTRIES = 300

// ---------------------------------------------------------------------------------------------------------------
// Verdicts

const blocked = (code: SafetyCode, message: string): Safety => ({ level: 'blocked', code, message })
const warn = (code: SafetyCode, message: string): Safety => ({ level: 'warn', code, message })

const RANK: Record<SafetyLevel, number> = { ok: 0, warn: 1, blocked: 2 }

/** The more serious of two verdicts (the first wins a tie). */
export function worst(a: Safety, b: Safety): Safety {
  return RANK[b.level] > RANK[a.level] ? b : a
}

/** The lower-case last extension of a file name, without the dot ('' when there is none). */
export function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const dot = base.trimEnd().lastIndexOf('.')
  return dot > 0 ? base.trimEnd().slice(dot + 1).toLowerCase() : ''
}

// ---------------------------------------------------------------------------------------------------------------
// 1. The name

/** What the name alone says. Cheap: used for listings, where the bytes aren't at hand. */
export function checkName(name: string): Safety {
  if (BIDI_CONTROLS.test(name)) {
    return blocked('hidden_extension', 'Blocked because its name hides its real file type.')
  }
  const ext = extensionOf(name)
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return blocked('blocked_type', `Blocked because .${ext} files can run programs on your computer.`)
  }
  if (MACRO_EXTENSIONS.has(ext)) return macroWarning()
  if (OPAQUE_ARCHIVES.has(ext)) return opaqueWarning()
  return SAFE
}

const macroWarning = () =>
  warn('macros', 'Contains macros, which can run code. Only open it if you trust the sender, and don’t enable macros.')
const opaqueWarning = () => warn('unchecked_archive', 'xstate can’t look inside this kind of archive. Only open it if you trust the sender.')
const tooLargeWarning = () => warn('unchecked_archive', 'Too large for xstate to look inside. Only open it if you trust the sender.')
const encryptedWarning = () =>
  warn('encrypted_archive', 'Password-protected, so xstate couldn’t check what’s inside. Only open it if you trust the sender.')

// ---------------------------------------------------------------------------------------------------------------
// 2. The bytes

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** A program, judged by its first bytes, or null. */
export function executableKind(head: Uint8Array): string | null {
  if (startsWith(head, [0x4d, 0x5a]) && head.length >= 0x40) {
    // MZ alone also starts some text files; a real Windows program has "PE\0\0" where the header says.
    const pe = head[0x3c]! | (head[0x3d]! << 8) | (head[0x3e]! << 16) | (head[0x3f]! << 24)
    if (pe > 0 && startsWith(head, [0x50, 0x45, 0, 0], pe)) return 'a Windows program'
  }
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'a Linux program'
  for (const sig of [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]]) {
    if (startsWith(head, sig)) return 'a Mac or Java program'
  }
  if (startsWith(head, [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0])) return 'a Windows shortcut'
  if (startsWith(head, ascii('MSCF'))) return 'a Windows installer cabinet'
  if (startsWith(head, ascii('vhdxfile')) || startsWith(head, ascii('conectix'))) return 'a disk image'
  for (const at of [0x8001, 0x8801, 0x9001]) if (startsWith(head, ascii('CD001'), at)) return 'a disk image'
  return null
}

/** Whether the whole file has to be read to judge it: archives and old Office files. */
export function needsFullRead(head: Uint8Array, name: string): boolean {
  const ext = extensionOf(name)
  return isZip(head) || isGzip(head) || isTar(head) || isOle(head) || ['zip', 'gz', 'tgz', 'tar'].includes(ext)
}

const isZip = (b: Uint8Array) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])
const isGzip = (b: Uint8Array) => startsWith(b, [0x1f, 0x8b])
const isTar = (b: Uint8Array) => startsWith(b, ascii('ustar'), 257)
const isOle = (b: Uint8Array) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const is7zOrRar = (b: Uint8Array) => startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || startsWith(b, ascii('Rar!\x1a\x07'))

/** Judges the first bytes (and the name). Enough for everything but archives and old Office files. */
export function checkHead(head: Uint8Array, name: string): Safety {
  const byName = checkName(name)
  if (byName.level === 'blocked') return byName
  const kind = executableKind(head)
  if (kind) return blocked('executable', `Blocked because it’s ${kind}, whatever its name says.`)
  if (is7zOrRar(head)) return worst(byName, opaqueWarning())
  return byName
}

// ---------------------------------------------------------------------------------------------------------------
// 3. The whole file

/** The full verdict on a file's bytes. `depth` counts archives we're inside. */
export async function inspect(bytes: Uint8Array, name: string, depth = 0): Promise<Safety> {
  let verdict = checkHead(bytes.subarray(0, HEAD_BYTES), name)
  if (verdict.level === 'blocked') return verdict
  if (isZip(bytes)) verdict = worst(verdict, await inspectZip(bytes, depth))
  else if (isGzip(bytes)) verdict = worst(verdict, await inspectGzip(bytes, name, depth))
  else if (isTar(bytes)) verdict = worst(verdict, await inspectTar(bytes, depth))
  else if (isOle(bytes) && hasVbaProject(bytes)) verdict = worst(verdict, macroWarning())
  return verdict
}

/** What an entry inside an archive says about the archive. */
async function inspectEntry(entryName: string, content: Uint8Array | null, depth: number): Promise<Safety> {
  const byName = checkName(entryName)
  if (byName.level === 'blocked') return inArchive(entryName)
  if (!content) return byName
  const inner = depth + 1 < MAX_DEPTH ? await inspect(content, entryName, depth + 1) : checkHead(content, entryName)
  return inner.level === 'blocked' ? inArchive(entryName) : worst(byName, inner)
}

const inArchive = (entryName: string) =>
  blocked('blocked_in_archive', `Blocked because it contains ${baseName(entryName)}, a file type that can run programs.`)

const baseName = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path

// Zip ------------------------------------------------------------------------------------------------------------

type ZipEntry = { name: string; encrypted: boolean; method: number; compressed: number; size: number; offset: number }

async function inspectZip(bytes: Uint8Array, depth: number): Promise<Safety> {
  const entries = zipEntries(bytes)
  if (!entries) return warn('unchecked_archive', 'xstate couldn’t read this archive. Only open it if you trust the sender.')
  let verdict = SAFE
  let sniffed = 0
  for (const e of entries) {
    if (e.name.endsWith('/')) continue
    // Office files are zips: a VBA project inside means macros, whatever the extension says.
    if (/(^|\/)vbaProject\.bin$/i.test(e.name)) verdict = worst(verdict, macroWarning())
    if (e.encrypted) {
      const byName = checkName(e.name)
      if (byName.level === 'blocked') return inArchive(e.name)
      verdict = worst(verdict, encryptedWarning())
      continue
    }
    let content: Uint8Array | null = null
    if (sniffed < MAX_SNIFFED_ENTRIES && (e.method === 0 || e.method === 8)) {
      sniffed++
      // Far enough for the program check; nested archives and old Office files are then read in full.
      content = await zipEntryData(bytes, e, HEAD_BYTES)
      if (content && depth + 1 < MAX_DEPTH && e.size <= MAX_NESTED_BYTES && needsFullRead(content, e.name)) {
        content = await zipEntryData(bytes, e, MAX_NESTED_BYTES)
      }
    }
    const v = await inspectEntry(e.name, content, depth)
    if (v.level === 'blocked') return v
    verdict = worst(verdict, v)
  }
  return verdict
}

/** Bytes as Latin-1 text (Workers' TextDecoder only knows UTF-8). Zip names without the UTF-8 flag, tar headers. */
const latin1 = (b: Uint8Array) => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return s
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 2 ** 32

/** The central directory's entries, or null when it can't be read (damaged, or not really a zip). */
export function zipEntries(b: Uint8Array): ZipEntry[] | null {
  // End of central directory: 22 bytes plus a comment of up to 64 KB, at the very end.
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  let count = u16(b, eocd + 10)
  let cdOffset = u32(b, eocd + 16)
  if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 && u32(b, eocd - 20) === 0x07064b50) {
    const z64 = u64(b, eocd - 12)
    if (z64 + 56 > b.length || u32(b, z64) !== 0x06064b50) return null
    count = u64(b, z64 + 32)
    cdOffset = u64(b, z64 + 48)
  }
  const entries: ZipEntry[] = []
  let at = cdOffset
  for (let i = 0; i < count; i++) {
    if (at + 46 > b.length || u32(b, at) !== 0x02014b50) return null
    const flags = u16(b, at + 8)
    const nameLen = u16(b, at + 28)
    const extraLen = u16(b, at + 30)
    const commentLen = u16(b, at + 32)
    const nameBytes = b.subarray(at + 46, at + 46 + nameLen)
    const name = flags & 0x800 ? new TextDecoder().decode(nameBytes) : latin1(nameBytes)
    entries.push({
      name,
      encrypted: (flags & 1) === 1,
      method: u16(b, at + 10),
      compressed: u32(b, at + 20),
      size: u32(b, at + 24),
      offset: u32(b, at + 42),
    })
    at += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** An entry's bytes, decompressed, at most `limit` of them. Null when it can't be read. */
async function zipEntryData(b: Uint8Array, e: ZipEntry, limit: number): Promise<Uint8Array | null> {
  // Sizes of 0xFFFFFFFF live in a zip64 extra field; skip those rather than parse it.
  if (e.compressed === 0xffffffff || e.offset === 0xffffffff) return null
  if (e.offset + 30 > b.length || u32(b, e.offset) !== 0x04034b50) return null
  const start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28)
  const raw = b.subarray(start, Math.min(b.length, start + e.compressed))
  if (e.method === 0) return raw.subarray(0, limit)
  return decompress(raw, 'deflate-raw', limit)
}

// Gzip and tar ---------------------------------------------------------------------------------------------------

async function inspectGzip(bytes: Uint8Array, name: string, depth: number): Promise<Safety> {
  // The header may carry the original file name (FNAME): "invoice.exe.gz".
  const flags = bytes[3] ?? 0
  let original = ''
  if (flags & 0x08) {
    let at = 10
    if (flags & 0x04) at += 2 + u16(bytes, 10)
    const end = bytes.indexOf(0, at)
    if (end > at) original = latin1(bytes.subarray(at, end))
  }
  const inner = original || name.replace(/\.(gz|tgz)$/i, (m) => (m.toLowerCase() === '.tgz' ? '.tar' : ''))
  if (depth + 1 >= MAX_DEPTH) return inspectEntry(inner, null, depth)
  const content = await decompress(bytes, 'gzip', MAX_NESTED_BYTES)
  return inspectEntry(inner, content, depth)
}

async function inspectTar(bytes: Uint8Array, depth: number): Promise<Safety> {
  let verdict = SAFE
  let sniffed = 0
  for (let at = 0; at + 512 <= bytes.length; ) {
    const header = bytes.subarray(at, at + 512)
    if (header.every((x) => x === 0)) break
    const field = (from: number, len: number) => latin1(header.subarray(from, from + len)).replace(/\0.*$/s, '')
    const prefix = field(345, 155)
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100)
    const size = parseInt(field(124, 12).trim() || '0', 8) || 0
    const type = field(156, 1)
    const dataStart = at + 512
    if (type === '0' || type === '' || type === '\0') {
      const content = sniffed++ < MAX_SNIFFED_ENTRIES ? bytes.subarray(dataStart, Math.min(bytes.length, dataStart + size)) : null
      const v = await inspectEntry(name, content, depth)
      if (v.level === 'blocked') return v
      verdict = worst(verdict, v)
    }
    at = dataStart + Math.ceil(size / 512) * 512
  }
  return verdict
}

/** Decompresses at most `limit` bytes (anything past it is ignored, which also stops zip bombs). */
async function decompress(data: Uint8Array, format: 'gzip' | 'deflate-raw', limit: number): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(format))
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
    await reader.cancel().catch(() => null)
    return concat(chunks, limit)
  } catch {
    return null
  }
}

// Old Office files ------------------------------------------------------------------------------------------------

/** OLE2 Office files keep macros in a "_VBA_PROJECT" stream; its name appears in UTF-16 in the directory. */
const VBA_MARK = new Uint8Array([...'_VBA_PROJECT'].flatMap((c) => [c.charCodeAt(0), 0]))

function hasVbaProject(b: Uint8Array): boolean {
  outer: for (let i = 0; i + VBA_MARK.length <= b.length; i++) {
    if (b[i] !== 0x5f) continue
    for (let j = 1; j < VBA_MARK.length; j++) if (b[i + j] !== VBA_MARK[j]) continue outer
    return true
  }
  return false
}

// ---------------------------------------------------------------------------------------------------------------
// Streams

export function concat(chunks: Uint8Array[], limit = Infinity): Uint8Array {
  const total = Math.min(limit, chunks.reduce((n, c) => n + c.byteLength, 0))
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    if (at >= total) break
    const part = c.subarray(0, total - at)
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

/**
 * Judges a file as it streams past, and hands back a stream of the same bytes for the caller to send on. Reads
 * only the first 64 KB, unless the file is an archive or old Office file, which is read in full up to
 * MAX_INSPECT_BYTES (larger ones get a warning). Nothing is passed on before the verdict, so a blocked file
 * never reaches its destination.
 */
export async function inspectStream(body: ReadableStream<Uint8Array>, name: string): Promise<{ safety: Safety; body: ReadableStream<Uint8Array> }> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let read = 0
  let done = false
  const pull = async (until: number) => {
    while (!done && read < until) {
      const next = await reader.read()
      if (next.done) done = true
      else {
        chunks.push(next.value)
        read += next.value.byteLength
      }
    }
  }

  await pull(HEAD_BYTES)
  const head = concat(chunks, HEAD_BYTES)
  let safety = checkHead(head, name)
  if (safety.level !== 'blocked' && needsFullRead(head, name)) {
    await pull(MAX_INSPECT_BYTES + 1)
    safety = done ? await inspect(concat(chunks), name) : worst(safety, tooLargeWarning())
  }

  // The bytes already read, then the rest of the original stream.
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      if (done) controller.close()
    },
    async pull(controller) {
      if (done) return
      const next = await reader.read()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  return { safety, body: replay }
}

// ---------------------------------------------------------------------------------------------------------------
// Storing verdicts (files.safety): 'ok', 'warn:<code>' or 'blocked:<code>'.

export function encodeSafety(s: Safety): string {
  return s.level === 'ok' ? 'ok' : `${s.level}:${s.code}`
}

/** A stored verdict back as a Safety, with its message. Falls back to the name for rows checked before this. */
export function decodeSafety(stored: string | null | undefined, name: string): Safety {
  if (!stored) return checkName(name)
  if (stored === 'ok') return SAFE
  const [level, code] = stored.split(':') as [SafetyLevel, SafetyCode]
  return { level, code, message: MESSAGES[code] ?? checkName(name).message ?? 'Blocked for your safety.' }
}

const MESSAGES: Partial<Record<SafetyCode, string>> = {
  executable: 'Blocked because it’s a program, whatever its name says.',
  blocked_in_archive: 'Blocked because it contains a file type that can run programs.',
  hidden_extension: 'Blocked because its name hides its real file type.',
  macros: macroWarning().message,
  encrypted_archive: encryptedWarning().message,
  unchecked_archive: opaqueWarning().message,
}
