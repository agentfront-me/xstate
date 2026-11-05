// Stalwart's JMAP ids are base32 numerals of an internal u64: most significant symbol first, alphabet
// `a-z 7 9 2 0 1 3`, no leading zero symbols (zero is "a"). Telemetry events and webhooks give the internal number
// (e.g. accountId = 10); JMAP and our mailboxes.stalwart_id use the text ("k"). Source: stalwartlabs/encodify,
// src/base32 (`STALWART.encode_u64`); its example 20080258862541 encodes to "singleton".

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz792013'

/** The JMAP id for an internal Stalwart id, e.g. 10 → "k". */
export function jmapId(value: number | bigint | string): string {
  let n = BigInt(value)
  if (n < 0n) throw new RangeError('Stalwart ids are unsigned')
  if (n === 0n) return 'a'
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n & 31n)] + out
    n >>= 5n
  }
  return out
}
