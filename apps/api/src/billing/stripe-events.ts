// Stripe's objects turned into xstate's neutral billing types (./provider.ts), and Stripe's webhook signature check.
// No runtime imports, so `pnpm test` runs this file directly under Node. Handles both the older Stripe API shapes
// (invoice.subscription, subscription.current_period_end) and the newer ones (invoice.parent.subscription_details,
// items[].current_period_end), since the account's default API version decides which arrive.

import type { BillingEvent, Subscription } from './provider'
import type { SubscriptionStatus } from './plans'

/** Lookup keys of the two Growth prices (scripts/billing-catalog.mjs creates them). */
export const LOOKUP = { base: 'xstate_growth_base', extra: 'xstate_growth_extra_100' } as const

type StripeItem = { id: string; quantity?: number; current_period_end?: number; price?: { id: string; lookup_key?: string | null } }
export type StripeSubscription = {
  id: string
  customer: string | { id: string }
  status: string
  metadata?: Record<string, string>
  items?: { data: StripeItem[] }
  current_period_end?: number
  cancel_at?: number | null
  cancel_at_period_end?: boolean
  start_date?: number
}

const iso = (seconds: number | null | undefined) => (typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null)
const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : (v?.id ?? null))

function statusOf(status: string): SubscriptionStatus {
  switch (status) {
    case 'active':
    case 'trialing':
    case 'past_due':
    case 'paused':
    case 'canceled':
      return status
    // Retries ran out: no longer billing, but not ended by anyone either.
    case 'unpaid':
      return 'paused'
    default:
      return 'incomplete'
  }
}

/**
 * The Stripe API version xstate's calls and webhook endpoint use, so payload shapes don't follow the account's
 * default (the shared HireNinja account defaults to 2018-11-08). Change it together with the endpoint's version.
 */
export const STRIPE_VERSION = '2025-08-27.basil'

/** A subscription to xstate Growth (the account also bills other products, whose events are ignored). */
export function isXstate(sub: StripeSubscription): boolean {
  return !!sub.items?.data.some((i) => i.price?.lookup_key === LOOKUP.base || i.price?.lookup_key === LOOKUP.extra)
}

/** The "Extra 100 people" item of a subscription, if it has one. */
export function extraItem(sub: StripeSubscription): StripeItem | null {
  return sub.items?.data.find((i) => i.price?.lookup_key === LOOKUP.extra) ?? null
}

export function toSubscription(sub: StripeSubscription, updatedAt: string): Subscription {
  const itemEnds = (sub.items?.data ?? []).map((i) => i.current_period_end ?? 0)
  const periodEnd = iso(sub.current_period_end ?? (itemEnds.length ? Math.max(...itemEnds) : null))
  return {
    id: sub.id,
    customerId: idOf(sub.customer) ?? '',
    organizationId: sub.metadata?.organizationId ?? null,
    status: statusOf(sub.status),
    extraHundreds: extraItem(sub)?.quantity ?? 0,
    periodEnd,
    cancelAt: iso(sub.cancel_at) ?? (sub.cancel_at_period_end ? periodEnd : null),
    startedAt: iso(sub.start_date),
    updatedAt,
  }
}

type StripeInvoice = {
  id: string
  customer?: string | { id: string } | null
  currency?: string
  amount_paid?: number
  amount_due?: number
  tax?: number | null
  total_taxes?: { amount: number }[] | null
  billing_reason?: string | null
  subscription?: string | { id: string } | null
  subscription_details?: { metadata?: Record<string, string> } | null
  parent?: { subscription_details?: { subscription?: string | { id: string }; metadata?: Record<string, string> } | null } | null
}

type StripeCharge = {
  id: string
  customer?: string | { id: string } | null
  currency?: string
  amount_refunded?: number
  refunded?: boolean
  payment_intent?: string | { id: string } | null
}

export type StripeEvent = { id: string; type: string; created: number; data: { object: unknown } }

function reasonOf(reason: string | null | undefined): 'new' | 'renewal' | 'change' | 'other' {
  if (reason === 'subscription_create') return 'new'
  if (reason === 'subscription_cycle') return 'renewal'
  if (reason === 'subscription_update') return 'change'
  return 'other'
}

function invoicePayment(event: StripeEvent, status: 'paid' | 'failed'): BillingEvent {
  const inv = event.data.object as StripeInvoice
  const details = inv.parent?.subscription_details
  const tax = typeof inv.tax === 'number' ? inv.tax : (inv.total_taxes ?? []).reduce((n, t) => n + (t.amount ?? 0), 0)
  const gross = status === 'paid' ? (inv.amount_paid ?? 0) : (inv.amount_due ?? 0)
  return {
    kind: 'payment',
    id: event.id,
    status,
    amount: Math.max(0, gross - tax),
    currency: inv.currency ?? 'usd',
    reason: reasonOf(inv.billing_reason),
    paymentId: inv.id,
    fullRefund: false,
    organizationId: details?.metadata?.organizationId ?? inv.subscription_details?.metadata?.organizationId ?? null,
    subscriptionId: idOf(details?.subscription ?? inv.subscription),
    customerId: idOf(inv.customer),
  }
}

/**
 * What a Stripe event means for xstate. checkout.session.completed is left to the caller (it needs the
 * subscription fetched); events xstate doesn't use come back as an empty list.
 */
export function toEvents(event: StripeEvent): BillingEvent[] {
  const updatedAt = new Date(event.created * 1000).toISOString()
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      const sub = event.data.object as StripeSubscription
      return isXstate(sub) ? [{ kind: 'subscription', id: event.id, subscription: toSubscription(sub, updatedAt) }] : []
    }
    case 'invoice.paid':
      return [invoicePayment(event, 'paid')]
    case 'invoice.payment_failed':
      return [invoicePayment(event, 'failed')]
    case 'charge.refunded': {
      const charge = event.data.object as StripeCharge
      return [
        {
          kind: 'payment',
          id: event.id,
          status: 'refunded',
          amount: charge.amount_refunded ?? 0,
          currency: charge.currency ?? 'usd',
          reason: 'other',
          paymentId: idOf(charge.payment_intent) ?? charge.id,
          fullRefund: !!charge.refunded,
          organizationId: null,
          subscriptionId: null,
          customerId: idOf(charge.customer),
        },
      ]
    }
    default:
      return []
  }
}

/**
 * Stripe-Signature is "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${payload}`>[,v1=…]". True when one v1 matches
 * and t is within `toleranceSeconds` of now.
 */
export async function verifyStripeSignature(
  secret: string,
  header: string,
  payload: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = header.split(',').map((p) => p.trim().split('='))
  const t = Number(parts.find(([k]) => k === 't')?.[1])
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '')
  if (!Number.isFinite(t) || !signatures.length || Math.abs(nowSeconds - t) > toleranceSeconds) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)))
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  return signatures.some((s) => constantTimeEqual(s, expected))
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Stripe's form encoding: nested objects and arrays as key[sub][0]=value. */
export function formEncode(params: Record<string, unknown>): string {
  const out = new URLSearchParams()
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) value.forEach((v, i) => add(`${key}[${i}]`, v))
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v)
    else out.append(key, String(value))
  }
  for (const [k, v] of Object.entries(params)) add(k, v)
  return out.toString()
}
