// Whether a received message's From address is proven, from what Amazon SES found when it received it
// (docs/mailbox-store-plan.md, phase 3c). SES puts `Authentication-Results: amazonses.com; …` at the top of every
// message it receives, above anything the sender wrote; only that first header is read, so a sender can't add their
// own "dmarc=pass". The From domain is proven by `dmarc=pass header.from=<domain>`, or by a passing DKIM signature of
// that domain (or a parent or child of it, as DMARC's relaxed alignment allows). SPF alone proves only the envelope
// sender, not From, so it doesn't count. Pure: no runtime imports, so `pnpm test` runs it under Node.

export type SenderProof = { proven: boolean; how: 'dmarc' | 'dkim' | null; reason: string | null }

/** The header block of a raw message (up to the first blank line), unfolded, as [name, value] in order. */
export function headerLines(raw: Uint8Array): [string, string][] {
  const limit = Math.min(raw.length, 256 * 1024)
  let end = limit
  for (let i = 0; i + 1 < limit; i++) {
    if (raw[i] === 10 && (raw[i + 1] === 10 || (raw[i + 1] === 13 && raw[i + 2] === 10))) {
      end = i
      break
    }
  }
  const text = new TextDecoder('latin1').decode(raw.subarray(0, end)).replace(/\r?\n[ \t]+/g, ' ')
  return text
    .split(/\r?\n/)
    .map((line) => {
      const colon = line.indexOf(':')
      return colon > 0 ? ([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as [string, string]) : null
    })
    .filter((x): x is [string, string] => x !== null)
}

/** Whether `fromAddress` is proven by SES's authentication results in these headers. */
export function proveSender(headers: [string, string][], fromAddress: string): SenderProof {
  const first = headers.find(([name]) => name === 'authentication-results')
  if (!first) return { proven: false, how: null, reason: 'no_authentication_results' }
  const clauses = first[1].split(';').map((c) => c.trim())
  if (clauses[0]?.toLowerCase() !== 'amazonses.com') return { proven: false, how: null, reason: 'not_from_ses' }
  const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1).toLowerCase()
  if (!domain) return { proven: false, how: null, reason: 'no_from' }

  const passing = (kind: string) => clauses.slice(1).filter((c) => new RegExp(`^${kind}=pass\\b`, 'i').test(c))
  // DMARC first: it is the check made for exactly this question.
  for (const clause of passing('dmarc')) {
    if (/header\.from=([^\s;]+)/i.exec(clause)?.[1]?.toLowerCase() === domain) return { proven: true, how: 'dmarc', reason: null }
  }
  for (const clause of passing('dkim')) {
    const signer = (/header\.d=([^\s;]+)/i.exec(clause)?.[1] ?? /header\.i=[^@\s;]*@([^\s;]+)/i.exec(clause)?.[1])?.toLowerCase()
    if (signer && aligned(signer, domain)) return { proven: true, how: 'dkim', reason: null }
  }
  return { proven: false, how: null, reason: 'not_authenticated' }
}

/** Relaxed alignment: the same domain, or one inside the other (mail.example.com and example.com). */
function aligned(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}
