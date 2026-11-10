// Turning a file into passages: text extraction and chunking. The chunking is pure, so `pnpm test` runs it under
// Node; only extractText touches Workers AI. Shared by the indexer and (later) by readText, so agents can read
// the same text the search found.

/** Target size of one passage, about 400 tokens: big enough to carry a fact, small enough to stay specific. */
export const CHUNK_CHARS = 1800
const OVERLAP = Math.round(CHUNK_CHARS * 0.15)
/** A document is cut here (about 1,000 PDF pages); anything longer is indexed in part and marked so. */
export const MAX_CHUNKS = 2000
/** Files bigger than this are skipped without being read from R2. */
export const MAX_INDEX_BYTES = 50 * 1024 * 1024

export type TextKind = 'pdf' | 'csv' | 'text'

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-ndjson|csv|markdown))/

/** How a file is read, or null for types search can't index (images, archives, Office files for now). */
export function textKind(contentType: string, name: string): TextKind | null {
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf'
  if (type === 'text/csv' || /\.csv$/i.test(name)) return 'csv'
  if (TEXT_TYPES.test(type)) return 'text'
  return null
}

type Ai = { toMarkdown(doc: { name: string; blob: Blob }): Promise<{ format: string; data?: string; error?: string }> }

/** The file's text. PDFs go through Workers AI's toMarkdown; everything else is read as UTF-8. */
export async function extractText(ai: Ai, kind: TextKind, name: string, bytes: ArrayBuffer): Promise<string> {
  if (kind !== 'pdf') return new TextDecoder().decode(bytes)
  // toMarkdown rejects a Blob without a type ("expected string to have >=1 characters").
  const result = await ai.toMarkdown({ name, blob: new Blob([bytes], { type: 'application/pdf' }) })
  if (result.format === 'error' || result.data === undefined) throw new Error(`toMarkdown: ${result.error ?? 'no output'}`)
  return stripConversionHeader(result.data)
}

/**
 * toMarkdown starts with the file name, a "## Metadata" block (producer, dates) and a "## Contents" heading before
 * the pages. None of that is worth a vector.
 */
export function stripConversionHeader(markdown: string): string {
  const contents = markdown.indexOf('\n## Contents\n')
  if (contents === -1) return markdown
  const start = markdown.indexOf('\n## Metadata\n')
  if (start === -1 || start > contents) return markdown
  return markdown.slice(contents + '\n## Contents\n'.length).trimStart()
}

/**
 * Splits text into passages of about CHUNK_CHARS. Prose is cut on blank lines, with 15% of the previous passage
 * repeated at the start of the next so a fact that straddles the cut is whole in one of them. CSV is cut on rows,
 * with the header row repeated in every passage so a row's columns keep their names.
 */
export function chunkText(text: string, kind: TextKind): { chunks: string[]; truncated: boolean } {
  const chunks = kind === 'csv' ? chunkRows(text) : chunkProse(text)
  return { chunks: chunks.slice(0, MAX_CHUNKS).map(wellFormed), truncated: chunks.length > MAX_CHUNKS }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * The text with any half of a character pair (emoji and other characters outside the basic plane take two UTF-16
 * code units) replaced by U+FFFD. Workers AI refuses a body holding one ("8006: must be valid JSON"), and some
 * emails carry them already broken.
 */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD')
}

/** `i`, moved back by one when it would split a character pair. */
function cutAt(text: string, i: number): number {
  if (i <= 0 || i >= text.length) return i
  const before = text.charCodeAt(i - 1)
  const after = text.charCodeAt(i)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? i - 1 : i
}

function chunkRows(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const header = lines.shift()
  if (header === undefined) return []
  const out: string[] = []
  let rows: string[] = []
  let size = 0
  for (const line of lines) {
    if (size + line.length > CHUNK_CHARS && rows.length) {
      out.push([header, ...rows].join('\n'))
      rows = []
      size = 0
    }
    rows.push(line)
    size += line.length + 1
  }
  if (rows.length) out.push([header, ...rows].join('\n'))
  return out.length ? out : [header]
}

function chunkProse(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const out: string[] = []
  let current = ''
  const push = () => {
    out.push(current)
    current = current.slice(cutAt(current, Math.max(0, current.length - OVERLAP)))
  }
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > CHUNK_CHARS) push()
    current = current ? `${current}\n\n${paragraph}` : paragraph
    // One paragraph longer than a chunk (a PDF page comes as one) is cut hard.
    while (current.length > CHUNK_CHARS * 1.5) {
      const end = cutAt(current, CHUNK_CHARS)
      out.push(current.slice(0, end))
      current = current.slice(cutAt(current, end - OVERLAP))
    }
  }
  if (current.trim()) out.push(current)
  return out
}
