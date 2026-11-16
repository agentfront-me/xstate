// Paddle Billing's REST API (https://developer.paddle.com/api-reference) and webhook signatures, with fetch and Web
// Crypto: no SDK, so nothing Node-only runs in the Worker. Sandbox or live follows the API key: sandbox keys start
// with pdl_sdbx_, live ones with pdl_live_.

export type PaddleEnv = { PADDLE_API_KEY?: string }

export type PaddleSubscription = {
  id: string
  status: string
  customer_id: string
  custom_data: Record<string, unknown> | null
  items: { price: { id: string }; quantity: number }[]
  current_billing_period: { starts_at: string; ends_at: string } | null
  scheduled_change: { action: string; effective_at: string } | null
  updated_at: string
}

export type PaddleTransaction = {
  id: string
  status: string
  customer_id: string | null
  subscription_id: string | null
  custom_data: Record<string, unknown> | null
}

export class PaddleError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'PaddleError'
    this.status = status
    this.code = code
  }
}

export function apiBase(apiKey: string): string {
  return apiKey.startsWith('pdl_live_') ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com'
}

export function environmentOf(apiKey: string): 'production' | 'sandbox' {
  return apiKey.startsWith('pdl_live_') ? 'production' : 'sandbox'
}

async function call<T>(env: PaddleEnv, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const key = env.PADDLE_API_KEY
  if (!key) throw new PaddleError(503, 'not_configured', 'PADDLE_API_KEY is not set')
  const res = await fetch(`${apiBase(key)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code?: string; detail?: string } } | null
  if (!res.ok || !json || json.data === undefined) {
    throw new PaddleError(res.status, json?.error?.code ?? 'paddle_error', `Paddle ${method} ${path}: ${json?.error?.detail ?? res.status}`)
  }
  return json.data
}

export const getSubscription = (env: PaddleEnv, id: string) =>
  call<PaddleSubscription>(env, 'GET', `/subscriptions/${encodeURIComponent(id)}`)

export const getTransaction = (env: PaddleEnv, id: string) =>
  call<PaddleTransaction>(env, 'GET', `/transactions/${encodeURIComponent(id)}`)

/** Replace the subscription's items. Charges or credits the difference now (prorated). */
export const updateSubscriptionItems = (env: PaddleEnv, id: string, items: { price_id: string; quantity: number }[]) =>
  call<PaddleSubscription>(env, 'PATCH', `/subscriptions/${encodeURIComponent(id)}`, {
    items,
    proration_billing_mode: 'prorated_immediately',
  })

/** Links into Paddle's customer portal: overview (invoices), and per subscription cancel and update payment method. */
export const createPortalSession = (env: PaddleEnv, customerId: string, subscriptionIds: string[]) =>
  call<{
    urls: {
      general: { overview: string }
      subscriptions: { id: string; cancel_subscription: string; update_subscription_payment_method: string }[]
    }
  }>(env, 'POST', `/customers/${encodeURIComponent(customerId)}/portal-sessions`, { subscription_ids: subscriptionIds })

/** How old a signature may be. Paddle signs every delivery, retries included, with a fresh timestamp. */
const SIGNATURE_TOLERANCE_SECONDS = 300

/**
 * Checks a Paddle-Signature header ("ts=…;h1=…", with a second h1 while a secret is being rotated) against the raw
 * body: HMAC-SHA256 of "<ts>:<body>" with the destination's secret, hex.
 */
export async function verifySignature(
  secret: string,
  header: string,
  rawBody: string,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!secret || !header) return false
  let ts = ''
  const h1: string[] = []
  for (const part of header.split(';')) {
    const [k, v] = part.split('=', 2) as [string, string | undefined]
    if (k?.trim() === 'ts' && v) ts = v.trim()
    else if (k?.trim() === 'h1' && v) h1.push(v.trim().toLowerCase())
  }
  if (!/^\d+$/.test(ts) || !h1.length) return false
  if (Math.abs(now - Number(ts)) > SIGNATURE_TOLERANCE_SECONDS) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${rawBody}`)))
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
  return h1.some((sig) => timingSafeEqual(sig, expected))
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
