// Amazon SES, for outbound mail. Stalwart relays every message for a non-local domain to SES (docs/stalwart-api.md
// §8). SES only sends for verified identities and signs with each domain's own DKIM key, so every customer domain
// is registered here: Easy DKIM (three CNAMEs the customer publishes) plus bounce and complaint notifications to
// our SNS topic (POST /webhooks/ses).
//
// Credentials: AWS_SES_ACCESS_KEY_ID / AWS_SES_SECRET_ACCESS_KEY, an IAM user allowed to manage identities only
// (not send). Without them, registration is skipped and domains fall back to Stalwart's DKIM record.

import { AwsClient } from 'aws4fetch'
import { EmailError } from './errors'

export type SesEnv = Pick<Env, 'AWS_SES_ACCESS_KEY_ID' | 'AWS_SES_SECRET_ACCESS_KEY' | 'AWS_SES_REGION' | 'SES_SNS_TOPIC_ARNS'>

/** SES's view of a domain: whether it may send, and the DKIM tokens behind its three CNAMEs. */
export type SesIdentity = { status: 'pending' | 'verified' | 'failed'; dkimTokens: string[] }

export const sesConfigured = (env: SesEnv) => !!(env.AWS_SES_ACCESS_KEY_ID && env.AWS_SES_SECRET_ACCESS_KEY)

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
  const raw = (await v2(env, 'GET', `/identities/${encodeURIComponent(domain)}`)) as V2Identity | null
  return raw ? toIdentity(raw) : null
}

/**
 * Registers a domain with SES (Easy DKIM, 2048-bit) and sends its bounces and complaints to our topic. Safe to
 * call again: an existing identity is read and its notification topics set again.
 */
export async function registerDomain(env: SesEnv, domain: string): Promise<SesIdentity> {
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
  const topic = env.SES_SNS_TOPIC_ARNS.split(',')[0]?.trim()
  if (topic) {
    for (const type of ['Bounce', 'Complaint']) {
      await v1(env, { Action: 'SetIdentityNotificationTopic', Identity: domain, NotificationType: type, SnsTopic: topic })
    }
  }
  return identity
}

/** Removes a domain from SES. One that isn't registered is fine. */
export async function deleteDomainIdentity(env: SesEnv, domain: string): Promise<void> {
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
