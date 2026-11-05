// Public DNS lookups for onboarding: who hosts a domain's DNS, and whether our records are in place.
// Uses Cloudflare's DNS-over-HTTPS JSON API, so lookups see what the rest of the internet sees.

const DOH_URL = 'https://cloudflare-dns.com/dns-query'
const TYPES = { MX: 15, TXT: 16, CNAME: 5, NS: 2 } as const

type RecordType = keyof typeof TYPES

/** A record the domain owner must add, and whether public DNS already has it. */
export type DnsRecord = {
  type: 'MX' | 'TXT' | 'CNAME'
  /** Relative to the domain: '@' for the apex, 'v1-rsa-20261103._domainkey' for a DKIM key. */
  name: string
  value: string
  purpose: 'Mail' | 'SPF' | 'DKIM' | 'DMARC'
  /** Mail works without it. DMARC is recommended but doesn't block verification. */
  required: boolean
  found: boolean
}

export type DnsProvider = { id: string; name: string }

// Matched against the domain's NS hosts. Domain Connect is not offered yet: each provider has to onboard our
// template first, so until then everyone gets the records table.
const PROVIDERS: { id: string; name: string; ns: RegExp }[] = [
  { id: 'cloudflare', name: 'Cloudflare', ns: /\.ns\.cloudflare\.com$/ },
  { id: 'godaddy', name: 'GoDaddy', ns: /\.domaincontrol\.com$/ },
  { id: 'ionos', name: 'IONOS', ns: /\.ui-dns\.(com|de|org|biz)$/ },
  { id: 'route53', name: 'Amazon Route 53', ns: /\.awsdns-\d+\./ },
  { id: 'google', name: 'Google Cloud DNS', ns: /\.googledomains\.com$/ },
  { id: 'squarespace', name: 'Squarespace', ns: /\.squarespacedns\.com$/ },
  { id: 'namecheap', name: 'Namecheap', ns: /\.registrar-servers\.com$/ },
  { id: 'porkbun', name: 'Porkbun', ns: /\.porkbun\.com$/ },
  { id: 'vercel', name: 'Vercel', ns: /\.vercel-dns\.com$/ },
  { id: 'digitalocean', name: 'DigitalOcean', ns: /\.digitalocean\.com$/ },
  { id: 'hostinger', name: 'Hostinger', ns: /\.dns-parking\.com$/ },
]

/** Whether the domain exists in public DNS, and which provider hosts its DNS if we recognize it. */
/**
 * Outside production, domains under the reserved `.test` TLD (RFC 2606: never registrable) skip public DNS: they
 * count as registered and every record as published, so local dev can take one through onboarding end to end.
 */
export function isTestDomain(env: Pick<Env, 'ENVIRONMENT'>, name: string): boolean {
  return (env.ENVIRONMENT as string) !== 'production' && (name === 'test' || name.endsWith('.test'))
}

export async function lookupDomain(name: string): Promise<{ registered: boolean; provider: DnsProvider | null }> {
  const answer = await resolve(name, 'NS')
  if (answer === null) return { registered: false, provider: null }
  const hosts = answer.map((ns) => ns.toLowerCase().replace(/\.$/, ''))
  const match = PROVIDERS.find((p) => hosts.some((host) => p.ns.test(host)))
  return { registered: true, provider: match ? { id: match.id, name: match.name } : null }
}

/**
 * Picks the records mail depends on out of Stalwart's zone file: MX, SPF, DKIM and DMARC. The rest (SRV,
 * MTA-STS, autoconfig, CAA) help mail apps and hardening but aren't needed to send and receive.
 *
 * Outbound mail goes through Amazon SES, which signs it, so when the domain is registered with SES its three
 * Easy DKIM CNAMEs (`sesDkim`) replace Stalwart's own DKIM keys (Stalwart no longer signs).
 */
export function essentialRecords(
  zoneFile: string,
  domain: string,
  sesDkim: Omit<DnsRecord, 'found'>[] = [],
): Omit<DnsRecord, 'found'>[] {
  const records: Omit<DnsRecord, 'found'>[] = []
  for (const { owner, type, value } of parseZone(zoneFile)) {
    const name = owner === domain ? '@' : owner.endsWith(`.${domain}`) ? owner.slice(0, -domain.length - 1) : owner
    if (type === 'MX' && name === '@') records.push({ type, name, value, purpose: 'Mail', required: true })
    else if (type === 'TXT' && name === '@' && value.startsWith('v=spf1')) {
      records.push({ type, name, value, purpose: 'SPF', required: true })
    } else if (type === 'TXT' && name.endsWith('._domainkey')) {
      if (!sesDkim.length) records.push({ type, name, value, purpose: 'DKIM', required: true })
    } else if (type === 'TXT' && name === '_dmarc') records.push({ type, name, value, purpose: 'DMARC', required: false })
  }
  // SES's DKIM keys go where Stalwart's were: after SPF, before DMARC.
  if (sesDkim.length) {
    const at = records.findIndex((r) => r.purpose === 'DMARC')
    records.splice(at === -1 ? records.length : at, 0, ...sesDkim)
  }
  return records
}

/** Looks each record up in public DNS. */
export async function checkRecords(records: Omit<DnsRecord, 'found'>[], domain: string): Promise<DnsRecord[]> {
  return Promise.all(
    records.map(async (record) => {
      const fqdn = record.name === '@' ? domain : `${record.name}.${domain}`
      const answer = (await resolve(fqdn, record.type)) ?? []
      return { ...record, found: answer.some((value) => matches(record, value)) }
    }),
  )
}

function matches(record: Omit<DnsRecord, 'found'>, published: string): boolean {
  if (record.type === 'TXT') {
    const value = joinTxt(published)
    // Any DMARC policy counts: the owner may already have one they prefer.
    if (record.purpose === 'DMARC') return value.startsWith('v=DMARC1')
    return squash(value) === squash(record.value)
  }
  if (record.type === 'MX') return mxHost(published) === mxHost(record.value)
  return hostname(published) === hostname(record.value)
}

/**
 * The mail server moved from mx.xstate.com to mx.xstate.io on 2026-11-05. Both names reach the same server, so a
 * domain whose MX still points at the old name keeps working and counts as set up.
 */
const LEGACY_MX_HOSTS: Record<string, string> = { 'mx.xstate.com': 'mx.xstate.io' }

/** `10 mx.xstate.com.` → `10 mx.xstate.io`: the MX data with any legacy host replaced by its current name. */
function mxHost(value: string): string {
  const [priority, host = ''] = hostname(value).split(/\s+/)
  return `${priority} ${LEGACY_MX_HOSTS[host] ?? host}`
}

/** The record data for a name and type, or null when the name doesn't exist (NXDOMAIN). */
async function resolve(name: string, type: RecordType): Promise<string[] | null> {
  const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`
  const res = await fetch(url, { headers: { Accept: 'application/dns-json' } })
  if (!res.ok) throw new Error(`DNS lookup for ${name} ${type} failed with HTTP ${res.status}`)
  const body = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] }
  if (body.Status === 3) return null
  return (body.Answer ?? []).filter((a) => a.type === TYPES[type]).map((a) => a.data)
}

/** Reads `owner IN TYPE value` lines, including TXT values split over several quoted strings in parentheses. */
function parseZone(zoneFile: string): { owner: string; type: string; value: string }[] {
  const entries: { owner: string; type: string; value: string }[] = []
  const flat = zoneFile.replace(/\(([^)]*)\)/g, (_, inner: string) => inner.replace(/\s*\n\s*/g, ' '))
  for (const line of flat.split('\n')) {
    const match = line.trim().match(/^(\S+)\s+IN\s+(\S+)\s+(.+)$/i)
    if (!match) continue
    const [, owner, type, data] = match as unknown as [string, string, string, string]
    const upper = type.toUpperCase()
    entries.push({
      owner: owner.toLowerCase().replace(/\.$/, ''),
      type: upper,
      value: upper === 'TXT' ? joinTxt(data) : data.trim().replace(/\.$/, ''),
    })
  }
  return entries
}

/** `"v=DKIM1; p=abc" "def"` → `v=DKIM1; p=abcdef`. Unquoted data is returned as is. */
function joinTxt(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'))
  return parts.length ? parts.join('') : data.trim()
}

function squash(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/;\s*/g, ';').trim().toLowerCase()
}

/** MX data is `10 mx.xstate.io.`; compare priority and host without the trailing dot. */
function hostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}
