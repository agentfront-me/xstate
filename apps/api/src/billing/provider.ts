// The one interface between xstate's billing and a payment provider (docs/billing-limits-plan.md §3.1). Everything
// else in billing/ speaks these types; only the provider's own file knows its API, ids and webhook format. Which
// provider is used comes from BILLING_PROVIDER, so moving to another means adding its file and changing that var.
//
// A provider whose keys aren't set answers null from providerFor, and billing reports itself unavailable.

import type { SubscriptionStatus } from './plans'
import { stripeProvider, type StripeEnv } from './stripe'

export type ProviderName = 'stripe' | 'paddle'

/** A subscription as xstate needs it, whatever the provider. */
export type Subscription = {
  id: string
  customerId: string
  /** The organization the subscription was bought for, when the provider carries it (checkout metadata). */
  organizationId: string | null
  status: SubscriptionStatus
  /** Quantity of the "Extra 100 people" item; 0 when the subscription has only the Growth base. */
  extraHundreds: number
  /** End of the period already paid for. */
  periodEnd: string | null
  /** When a scheduled cancellation takes effect, or null. */
  cancelAt: string | null
  startedAt: string | null
  /** When the provider last changed it: orders reports that arrive out of order. */
  updatedAt: string
}

/** What a verified webhook delivery means for xstate. Anything else the provider sends is dropped by its file. */
export type BillingEvent =
  | { kind: 'subscription'; id: string; subscription: Subscription }
  | {
      kind: 'payment'
      id: string
      status: 'paid' | 'failed' | 'refunded'
      /** Amount less tax, in minor units (cents). */
      amount: number
      currency: string
      /** For paid: why the payment happened. */
      reason: 'new' | 'renewal' | 'change' | 'other'
      /** The payment refunded, or the payment itself. */
      paymentId: string
      fullRefund: boolean
      organizationId: string | null
      subscriptionId: string | null
      customerId: string | null
    }

export type OrgForBilling = { id: string; name: string; customerId: string | null; ownerEmail: string | null }

export interface BillingProvider {
  readonly name: ProviderName
  /** A hosted checkout page for Growth at this size. The subscription it creates arrives by webhook. */
  checkout(org: OrgForBilling, extraHundreds: number, urls: { success: string; cancel: string }): Promise<{ url: string }>
  /** Right after checkout: the subscription the checkout created (null while the provider is still creating it). */
  confirmCheckout(sessionId: string): Promise<{ organizationId: string | null; subscription: Subscription | null }>
  /** The provider's customer portal: invoices, the card on file, cancelling. */
  portal(customerId: string, returnUrl: string): Promise<{ url: string }>
  /** Change Growth's size now, prorated. */
  setExtraHundreds(subscriptionId: string, extraHundreds: number): Promise<Subscription>
  getSubscription(subscriptionId: string): Promise<Subscription>
  /** Checks the delivery's signature and returns what it means; throws WebhookRejected when it isn't genuine. */
  verifyWebhook(request: Request): Promise<BillingEvent[]>
}

export class WebhookRejected extends Error {
  constructor(
    readonly status: 400 | 401 | 403,
    message: string,
  ) {
    super(message)
  }
}

/** A provider call that failed; status is the provider's HTTP status when it answered. */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type ProviderEnv = { BILLING_PROVIDER?: string } & StripeEnv

/** The configured provider, or null when billing isn't set up on this server. */
export function providerFor(env: ProviderEnv): BillingProvider | null {
  const name = (env.BILLING_PROVIDER ?? 'stripe') as ProviderName
  switch (name) {
    case 'stripe':
      return stripeProvider(env)
    default:
      return null
  }
}
