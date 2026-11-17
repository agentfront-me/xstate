// Vectorize ids for a document's passages. Vectorize allows at most 64 bytes per id. `<doc>:<n>` fits for files and
// for Stalwart mail (short message ids), and keeps that form so existing vectors stay where they are; a longer one,
// such as a store-held message with a 26-character ULID (`email:<mailbox uuid>:<ULID>:0`, 71 bytes), becomes
// `h:<32 hex>:<n>` from a fixed hash of the document id. The document id itself (vector metadata `doc`, D1
// `search_docs`) never changes, so search and deletion read it as before. Pure: `pnpm test` runs it under Node.

const MAX_ID_BYTES = 64
const enc = new TextEncoder()

export function vectorId(doc: string, i: number): string {
  const plain = `${doc}:${i}`
  return enc.encode(plain).length <= MAX_ID_BYTES ? plain : `h:${hash128(doc)}:${i}`
}

/** 128 bits of two FNV-1a 64-bit hashes (the second over the reversed text), as 32 hex characters. */
function hash128(text: string): string {
  const bytes = enc.encode(text)
  return fnv64(bytes) + fnv64(bytes.slice().reverse())
}

function fnv64(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n
  for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n)
  return h.toString(16).padStart(16, '0')
}
