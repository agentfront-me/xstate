// Paddle sends webhooks only from the addresses its /ips endpoint lists (live and sandbox lists differ). The list
// is fetched, not hard-coded, because Paddle can change it; it's kept per isolate for an hour, and a stale copy is
// used if a refresh fails. The signature check stays the real proof; this rejects everything else before it.

const TTL_MS = 60 * 60 * 1000

let cached: { base: string; cidrs: string[]; at: number } | null = null

/** Paddle's webhook source CIDRs from an API base (apiBase in paddle.ts), or null if none could be loaded. */
export async function paddleWebhookCidrs(base: string, now = Date.now()): Promise<string[] | null> {
  if (cached && cached.base === base && now - cached.at < TTL_MS) return cached.cidrs
  try {
    const res = await fetch(`${base}/ips`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { data?: { ipv4_cidrs?: unknown } }
    const cidrs = body.data?.ipv4_cidrs
    if (!Array.isArray(cidrs) || !cidrs.length || !cidrs.every((c) => typeof c === 'string')) {
      throw new Error('no ipv4_cidrs in response')
    }
    cached = { base, cidrs, at: now }
    return cidrs
  } catch (err) {
    console.error('billing webhook: could not load Paddle IPs', err)
    return cached && cached.base === base ? cached.cidrs : null
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null
    n = n * 256 + Number(p)
  }
  return n
}

/** Whether an IPv4 address falls in any of the CIDRs (a bare address counts as /32). IPv6 never matches. */
export function ipInCidrs(ip: string, cidrs: string[]): boolean {
  const addr = ipv4ToInt(ip)
  if (addr === null) return false
  return cidrs.some((cidr) => {
    const [range, bitsText = '32'] = cidr.split('/')
    const start = ipv4ToInt(range ?? '')
    const bits = Number(bitsText)
    if (start === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
    const size = 2 ** (32 - bits)
    return Math.floor(addr / size) === Math.floor(start / size)
  })
}

/** Test hook: forget the cached list. */
export function resetPaddleIpCache(): void {
  cached = null
}
