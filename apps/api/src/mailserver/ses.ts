// Amazon SES, for outbound mail. Stalwart relays every message for a non-local domain to SES (docs/stalwart-api.md
// §8). SES only sends for verified identities and signs with each domain's own DKIM key, so every customer domain
// is registered here: Easy DKIM (three CNAMEs the customer publishes) plus bounce, complaint and delivery notifications
// to our SNS topic (POST /webhooks/ses).
//
// Credentials: AWS_SES_ACCESS_KEY_ID / AWS_SES_SECRET_ACCESS_KEY, an IAM user allowed to manage identities only
// (not send). Without them, registration is skipped and domains fall back to Stalwart's DKIM record.
//
// SES_MODE picks what happens: "live" calls SES; "fake" (local dev) never calls AWS, hands out made-up DKIM tokens
// and reports the domain verified from the next check on; "off" skips SES as if it weren't configured.

import { AwsClient } from 'aws4fetch'
import { EmailError } from './errors'

export type SesEnv = Pick<Env, 'AWS_SES_ACCESS_KEY_ID' | 'AWS_SES_SECRET_ACCESS_KEY' | 'AWS_SES_REGION' | 'SES_SNS_TOPIC_ARNS' | 'SES_MODE'>

/** SES's view of a domain: whether it may send, and the DKIM tokens behind its three CNAMEs. */
export type SesIdentity = { status: 'pending' | 'verified' | 'failed'; dkimTokens: string[] }

type SesMode = 'live' | 'fake' | 'off'

function mode(env: SesEnv): SesMode {
  const value = (env.SES_MODE as string | undefined) ?? 'live'
  if (value === 'fake' || value === 'off') return value
  return env.AWS_SES_ACCESS_KEY_ID && env.AWS_SES_SECRET_ACCESS_KEY ? 'live' : 'off'
}

export const sesConfigured = (env: SesEnv) => mode(env) !== 'off'

/** Fake mode: three stable made-up tokens per domain, shaped like SES's. */
async function fakeTokens(domain: string): Promise<string[]> {
  const tokens: string[] = []
  for (let i = 1; i <= 3; i++) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${domain}#${i}`)))
    tokens.push([...digest.slice(0, 16)].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 32))
  }
  return tokens
}

let client: { key: string; aws: AwsClient } | null = null
function aws(env: SesEnv): AwsClient {
  if (client?.key !== env.AWS_SES_ACCESS_KEY_ID) {
    client = {
      key: env.AWS_SES_ACCESS_KEY_ID,
      aws: new AwsClient({
        accessKeyId: env.AWS_SES_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SES_SECRET_ACCESS_KEY,
        service: 'ses',
        region: env.AWS_SES_REGION,
      }),
    }
  }
  return client.aws
}

const endpoint = (env: SesEnv) => `https://email.${env.AWS_SES_REGION}.amazonaws.com`

type V2Identity = {
  VerifiedForSendingStatus?: boolean
  DkimAttributes?: { Status?: string; Tokens?: string[] }
}

/** SES API v2 (JSON). Returns null for 404. */
async function v2(env: SesEnv, method: string, path: string, body?: unknown): Promise<unknown | null> {
  const res = await aws(env).fetch(`${endpoint(env)}/v2/email${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 404) return null
  const text = await res.text()
  if (!res.ok) {
    const type = res.headers.get('x-amzn-ErrorType') ?? ''
    if (type.startsWith('AlreadyExistsException')) throw new SesAlreadyExists()
    throw new EmailError('ses_error', `Amazon SES returned HTTP ${res.status}: ${text.slice(0, 200)}`, 502)
  }
  return text ? JSON.parse(text) : {}
}

/** SES API v1 (Query). Identity notification topics only exist there. */
async function v1(env: SesEnv, params: Record<string, string>): Promise<void> {
  const body = new URLSearchParams({ ...params, Version: '2010-12-01' })
  const res = await aws(env).fetch(`${endpoint(env)}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    throw new EmailError('ses_error', `Amazon SES ${params.Action} returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, 502)
  }
}

class SesAlreadyExists extends Error {}

function toIdentity(raw: V2Identity): SesIdentity {
  const dkim = raw.DkimAttributes?.Status
  return {
    status: raw.VerifiedForSendingStatus ? 'verified' : dkim === 'FAILED' ? 'failed' : 'pending',
    dkimTokens: raw.DkimAttributes?.Tokens ?? [],
  }
}

/** SES's current view of a domain, or null if it isn't registered. */
export async function getDomainIdentity(env: SesEnv, domain: string): Promise<SesIdentity | null> {
  // Only asked about domains already registered, so a fake one is verified from its first check on.
  if (mode(env) === 'fake') return { status: 'verified', dkimTokens: await fakeTokens(domain) }
  const raw = (await v2(env, 'GET', `/identities/${encodeURIComponent(domain)}`)) as V2Identity | null
  return raw ? toIdentity(raw) : null
}

/**
 * Registers a domain with SES (Easy DKIM, 2048-bit) and sends its bounces, complaints and deliveries to our topic. Safe to
 * call again: an existing identity is read and its notification topics set again.
 */
export async function registerDomain(env: SesEnv, domain: string): Promise<SesIdentity> {
  if (mode(env) === 'fake') return { status: 'pending', dkimTokens: await fakeTokens(domain) }
  let identity: SesIdentity
  try {
    const created = (await v2(env, 'POST', '/identities', {
      EmailIdentity: domain,
      DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
    })) as { VerifiedForSendingStatus?: boolean; DkimAttributes?: V2Identity['DkimAttributes'] }
    identity = toIdentity(created)
  } catch (err) {
    if (!(err instanceof SesAlreadyExists)) throw err
    identity = (await getDomainIdentity(env, domain))!
  }
  await setNotificationTopics(env, domain)
  return identity
}

/**
 * Sends the domain's bounces, complaints and deliveries to our SNS topic. Deliveries are the denominator for each
 * sender's bounce and complaint rates (mailserver/sending.ts). Safe to call again.
 */
export async function setNotificationTopics(env: SesEnv, domain: string): Promise<void> {
  if (mode(env) !== 'live') return
  const topic = env.SES_SNS_TOPIC_ARNS.split(',')[0]?.trim()
  if (!topic) return
  for (const type of ['Bounce', 'Complaint', 'Delivery']) {
    await v1(env, { Action: 'SetIdentityNotificationTopic', Identity: domain, NotificationType: type, SnsTopic: topic })
  }
}

/** Removes a domain from SES. One that isn't registered is fine. */
export async function deleteDomainIdentity(env: SesEnv, domain: string): Promise<void> {
  if (mode(env) === 'fake') return
  await v2(env, 'DELETE', `/identities/${encodeURIComponent(domain)}`)
}

/** The three CNAME records the customer publishes for Easy DKIM. */
export function dkimRecords(tokens: string[]) {
  return tokens.map((token) => ({
    type: 'CNAME' as const,
    name: `${token}._domainkey`,
    value: `${token}.dkim.amazonses.com`,
    purpose: 'DKIM' as const,
    required: true,
  }))
}
