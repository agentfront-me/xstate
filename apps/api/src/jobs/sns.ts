// Verifies Amazon SNS messages posted to our HTTPS endpoints. SNS signs each message with a certificate it hosts on
// sns.<region>.amazonaws.com; we check the certificate URL, rebuild the signed string, and verify the RSA signature
// (SHA1 for SignatureVersion 1, SHA256 for 2). See
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html

export type SnsMessage = {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation'
  MessageId: string
  TopicArn: string
  Message: string
  Timestamp: string
  SignatureVersion: string
  Signature: string
  SigningCertURL: string
  Subject?: string
  SubscribeURL?: string
  Token?: string
}

const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/
const certCache = new Map<string, Promise<CryptoKey[]>>()

/** True if the URL is an SNS-hosted HTTPS URL (signing certificate or subscribe link). */
export function isSnsUrl(value: string | undefined, path?: RegExp): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && CERT_HOST.test(url.hostname) && (!path || path.test(url.pathname))
  } catch {
    return false
  }
}

/** The exact string SNS signed: "Name\nValue\n" for each field, in this order. */
export function stringToSign(m: SnsMessage): string {
  const fields =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', ...(m.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
  return fields.map((f) => `${f}\n${String(m[f as keyof SnsMessage] ?? '')}\n`).join('')
}

/**
 * Verifies a message's signature. `fetchCert` is only replaced in tests; in production the certificate is always
 * fetched from SNS over HTTPS after the URL check.
 */
export async function verifySnsMessage(
  m: SnsMessage,
  fetchCert: (url: string) => Promise<string> = defaultFetchCert,
): Promise<boolean> {
  if (m.SignatureVersion !== '1' && m.SignatureVersion !== '2') return false
  if (!isSnsUrl(m.SigningCertURL, /\.pem$/)) return false
  const hash = m.SignatureVersion === '1' ? 'SHA-1' : 'SHA-256'
  let keys = certCache.get(`${hash} ${m.SigningCertURL}`)
  if (!keys) {
    keys = fetchCert(m.SigningCertURL).then((pem) => importCertKey(pem, hash))
    certCache.set(`${hash} ${m.SigningCertURL}`, keys)
    keys.catch(() => certCache.delete(`${hash} ${m.SigningCertURL}`))
  }
  const [key] = await keys
  const signature = Uint8Array.from(atob(m.Signature), (c) => c.charCodeAt(0))
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key!, signature, new TextEncoder().encode(stringToSign(m)))
}

async function defaultFetchCert(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetching SNS certificate failed: HTTP ${res.status}`)
  return res.text()
}

async function importCertKey(pem: string, hash: 'SHA-1' | 'SHA-256'): Promise<CryptoKey[]> {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const { spki, notAfter } = readCertificate(der)
  if (notAfter < new Date()) throw new Error('SNS certificate has expired')
  return [await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify'])]
}

// Minimal X.509 reading: just the subjectPublicKeyInfo and the expiry date (RFC 5280 §4.1).

type Tlv = { tag: number; start: number; contentStart: number; end: number }

function readTlv(der: Uint8Array, pos: number): Tlv {
  const tag = der[pos]!
  let len = der[pos + 1]!
  let contentStart = pos + 2
  if (len & 0x80) {
    const bytes = len & 0x7f
    len = 0
    for (let i = 0; i < bytes; i++) len = len * 256 + der[pos + 2 + i]!
    contentStart += bytes
  }
  return { tag, start: pos, contentStart, end: contentStart + len }
}

function children(der: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = []
  for (let pos = parent.contentStart; pos < parent.end; ) {
    const tlv = readTlv(der, pos)
    out.push(tlv)
    pos = tlv.end
  }
  return out
}

function readCertificate(der: Uint8Array): { spki: Uint8Array; notAfter: Date } {
  const cert = readTlv(der, 0)
  const tbs = children(der, cert)[0]!
  const fields = children(der, tbs)
  // tbsCertificate: [0] version (optional), serial, signature, issuer, validity, subject, subjectPublicKeyInfo, …
  const offset = fields[0]!.tag === 0xa0 ? 1 : 0
  const validity = children(der, fields[offset + 3]!)
  const spki = fields[offset + 5]!
  return { spki: der.slice(spki.start, spki.end), notAfter: readTime(der, validity[1]!) }
}

function readTime(der: Uint8Array, t: Tlv): Date {
  const text = new TextDecoder().decode(der.slice(t.contentStart, t.end))
  // UTCTime YYMMDDhhmmssZ (years 1950–2049) or GeneralizedTime YYYYMMDDhhmmssZ.
  const full = t.tag === 0x17 ? `${Number(text.slice(0, 2)) >= 50 ? '19' : '20'}${text}` : text
  return new Date(`${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6, 8)}T${full.slice(8, 10)}:${full.slice(10, 12)}:${full.slice(12, 14)}Z`)
}
