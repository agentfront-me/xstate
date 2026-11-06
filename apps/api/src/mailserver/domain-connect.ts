// Domain Connect, synchronous flow (https://www.domainconnect.org): a signed link that sends the domain owner to
// their DNS provider (e.g. Cloudflare), which shows our template's records and adds them in one click.
//
// The template is docs/domain-connect/xstate.io.mail.json. A provider can only apply it once it's in the public
// Domain-Connect/Templates repo and the provider has onboarded it, so the link is offered only when
// DOMAIN_CONNECT_ENABLED is "true" and the provider says it supports the template. See docs/domain-connect/README.md.
//
// No runtime imports, so the unit tests can run this file directly under Node.

export const PROVIDER_ID = 'xstate.io'
export const SERVICE_ID = 'mail'

export type DomainConnectEnv = {
  /** "true" once the template is merged and onboarded. Anything else turns one-click setup off. */
  DOMAIN_CONNECT_ENABLED?: string
  /** RSA private key (PKCS#8) that signs apply links: PEM, or the base64 body on one line. Secret. */
  DOMAIN_CONNECT_PRIVATE_KEY?: string
  /** Host under syncPubKeyDomain (xstate.io) where the public key's TXT records live, e.g. "_dck1". */
  DOMAIN_CONNECT_KEY_HOST?: string
}

/** A DNS provider's Domain Connect settings (`GET {host}/v2/{domain}/settings`). */
export type DomainConnectSettings = {
  providerId?: string
  providerName?: string
  providerDisplayName?: string
  /** Base URL of the provider's consent pages for the synchronous flow. */
  urlSyncUX?: string
  /** Base URL of the provider's API, used to ask whether it supports a template. */
  urlAPI?: string
}

export function domainConnectEnabled(env: DomainConnectEnv): boolean {
  return env.DOMAIN_CONNECT_ENABLED === 'true' && !!env.DOMAIN_CONNECT_PRIVATE_KEY && !!env.DOMAIN_CONNECT_KEY_HOST
}

/**
 * The `_domainconnect` TXT value (e.g. `api.cloudflare.com/client/v4/dns/domainconnect`) → the provider's settings,
 * or null when they can't be fetched or don't offer the synchronous flow.
 */
export async function fetchSettings(txt: string, domain: string): Promise<DomainConnectSettings | null> {
  const base = toHttpsBase(txt.replace(/^"|"$/g, ''))
  if (!base) return null
  const res = await fetch(`${base}/v2/${encodeURIComponent(domain)}/settings`, { headers: { Accept: 'application/json' } })
  if (!res.ok) return null
  const settings = (await res.json().catch(() => null)) as DomainConnectSettings | null
  if (!settings || !toHttpsBase(settings.urlSyncUX ?? '')) return null
  return settings
}

/**
 * Whether the provider has onboarded our template: `GET {urlAPI}/v2/domainTemplates/providers/{id}/services/{id}`
 * answers 200 for a supported template and 404 otherwise. A provider without urlAPI can't be asked, so it counts
 * as unsupported.
 */
export async function supportsTemplate(settings: DomainConnectSettings): Promise<boolean> {
  const base = toHttpsBase(settings.urlAPI ?? '')
  if (!base) return false
  const res = await fetch(`${base}/v2/domainTemplates/providers/${PROVIDER_ID}/services/${SERVICE_ID}`)
  return res.ok
}

export type ApplyUrlInput = {
  urlSyncUX: string
  domain: string
  /** Template variables, e.g. { dkim1: '…', dkim2: '…', dkim3: '…' }. */
  variables: Record<string, string>
  redirectUri?: string
  state?: string
  keyHost: string
  privateKey: string
}

/**
 * `{urlSyncUX}/v2/domainTemplates/providers/{providerId}/services/{serviceId}/apply?domain=…&<variables>
 * &redirect_uri=…&state=…&key=…&sig=…`. The signature is RSA-SHA256 (PKCS#1 v1.5) over the URL-encoded query
 * string without `key` and `sig`, base64; `key` and `sig` are appended after it, `sig` last.
 */
export async function buildApplyUrl(input: ApplyUrlInput): Promise<string> {
  const params = new URLSearchParams({ domain: input.domain, ...input.variables })
  if (input.redirectUri) params.set('redirect_uri', input.redirectUri)
  if (input.state) params.set('state', input.state)
  // encodeURIComponent rather than URLSearchParams.toString(), which writes spaces as "+".
  const query = [...params].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  const sig = await sign(query, input.privateKey)
  const base = input.urlSyncUX.replace(/\/+$/, '')
  return (
    `${base}/v2/domainTemplates/providers/${PROVIDER_ID}/services/${SERVICE_ID}/apply?${query}` +
    `&key=${encodeURIComponent(input.keyHost)}&sig=${encodeURIComponent(sig)}`
  )
}

/** Base64 RSASSA-PKCS1-v1_5 SHA-256 signature of `data` with a PKCS#8 key (PEM or bare base64). */
export async function sign(data: string, privateKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(pemBody(privateKey)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data))
  return bytesToBase64(new Uint8Array(signature))
}

/**
 * The TXT records that publish a public key (SPKI, PEM or bare base64) at `{keyHost}.{syncPubKeyDomain}`:
 * `p=1,a=RS256,d=…`, split so each stays well under DNS's 255-byte string limit.
 */
export function publicKeyRecords(publicKey: string, chunk = 200): string[] {
  const body = pemBody(publicKey)
  const records: string[] = []
  for (let i = 0; i < body.length; i += chunk) records.push(`p=${records.length + 1},a=RS256,d=${body.slice(i, i + chunk)}`)
  return records
}

/** `api.cloudflare.com/client/v4/dns/domainconnect` or an https URL → `https://…` without a trailing slash. */
function toHttpsBase(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  } catch {
    return null
  }
}

function pemBody(key: string): string {
  return key.replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\\n|\s+/g, '')
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
