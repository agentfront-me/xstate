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
  purpose: 'Mail' | 'SPF' | 'DKIM' | 'DMARC' | 'Ownership'
  /** Mail works without it. DMARC is recommended but doesn't block verification. */
  required: boolean
  found: boolean
}

export type DnsProvider = { id: string; name: string }

// Matched against the domain's NS hosts, to tailor the verify step. One-click setup (Domain Connect) is discovered
// separately from the domain's _domainconnect record: see domain-connect.ts.
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
 * A domain's mail records (docs/mailbox-store-plan.md, phase 4a): SES receives (MX) and sends (SPF, SES's DKIM keys).
 * DMARC is recommended, not required; any policy the owner already has counts.
 */
export function storeRecords(region: string, sesDkim: Omit<DnsRecord, 'found'>[]): Omit<DnsRecord, 'found'>[] {
  return [
    { type: 'MX', name: '@', value: `10 inbound-smtp.${region}.amazonaws.com`, purpose: 'Mail', required: true },
    { type: 'TXT', name: '@', value: 'v=spf1 include:amazonses.com -all', purpose: 'SPF', required: true },
    ...sesDkim,
    { type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=reject', purpose: 'DMARC', required: false },
  ]
}

/** Records as a zone file, the shape the DNS records endpoint returns. */
export function zoneFile(domain: string, records: Omit<DnsRecord, 'found'>[]): string {
  return records
    .map((r) => {
      const owner = r.name === '@' ? `${domain}.` : `${r.name}.${domain}.`
      const value = r.type === 'TXT' ? `"${r.value}"` : r.type === 'MX' ? `${r.value}.` : `${r.value}.`
      return `${owner} IN ${r.type} ${value}`
    })
    .join('\n')
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
    if (record.purpose === 'SPF') return spfIncludes(value, record.value)
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
const MX_HOST = 'mx.xstate.io'

/** `10 mx.xstate.com.` → `10 mx.xstate.io`: the MX data with any legacy host replaced by its current name. */
function mxHost(value: string): string {
  const [priority, host = ''] = hostname(value).split(/\s+/)
  return `${priority} ${LEGACY_MX_HOSTS[host] ?? host}`
}

/**
 * Whether a published SPF record authorizes everything ours does. A record merged with the owner's other senders
 * (`v=spf1 mx include:_spf.google.com ~all`, which Domain Connect's SPFM produces) counts as long as it has our
 * mechanisms (`mx`); its `all` qualifier is the owner's choice.
 */
function spfIncludes(published: string, expected: string): boolean {
  const terms = (spf: string) => squash(spf).split(' ')
  const have = terms(published)
  if (have[0] !== 'v=spf1') return false
  return terms(expected)
    .slice(1)
    .filter((term) => !/^[-~?+]?all$/.test(term))
    .every((term) => have.includes(term) || have.includes(`+${term}`))
}

/** The TXT values at a name, joined from their quoted strings; empty when there are none. */
export async function resolveTxt(name: string): Promise<string[]> {
  return ((await resolve(name, 'TXT')) ?? []).map(joinTxt)
}

/**
 * The domain's MX hosts that aren't xstate's (lowercase, no trailing dot): where mail goes today and will stop going
 * once our MX replaces them.
 */
export async function otherMxHosts(domain: string): Promise<string[]> {
  const hosts = ((await resolve(domain, 'MX')) ?? []).map((data) => hostname(data).split(/\s+/)[1] ?? '').filter(Boolean)
  return [...new Set(hosts.filter((host) => host !== MX_HOST && !LEGACY_MX_HOSTS[host]))]
}

/** The domain's MX hosts as public DNS shows them (lowercase, no trailing dot); empty when there are none. */
export async function mxHosts(domain: string): Promise<string[]> {
  return ((await resolve(domain, 'MX')) ?? []).map((data) => hostname(data).split(/\s+/)[1] ?? '').filter(Boolean)
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
