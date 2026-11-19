// Settings → Billing: the organization's plan, checkout for Growth, size changes and the provider's customer portal
// (billing/). All off MCP: a connected app or agent must never buy or change a plan.

import { z } from 'zod'
import { confirmCheckout, getBilling, portalLink, setSize, startCheckout } from '../billing/service'
import { MAX_EXTRA_HUNDREDS } from '../billing/plans'
import { getUsage } from '../usage/service'
import { defineOperation } from './define'

const id = z.string().min(1).max(64)
const extraHundreds = z.number().int().min(0).max(MAX_EXTRA_HUNDREDS)

export const billingGet = defineOperation({
  name: 'billing_get',
  description:
    'The organization’s plan (free, growth or custom), subscription status, Growth size in people and its monthly ' +
    'price, the period end and any scheduled cancellation, list prices, and whether paid plans can be bought here.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/orgs/:organizationId/billing' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ billing: await getBilling(env, actor, input.organizationId) }),
})

export const billingCheckout = defineOperation({
  name: 'billing_checkout',
  description:
    'Start buying Growth at a size (extraHundreds: hundreds of people above the included 5,000). Answers the URL of ' +
    'the provider’s hosted checkout page to send the browser to.',
  input: z.object({ organizationId: id, extraHundreds }),
  http: { method: 'POST', path: '/orgs/:organizationId/billing/checkout' },
  mcp: false,
  run: ({ env, actor }, input) => startCheckout(env, actor, input.organizationId, input.extraHundreds),
})

export const billingConfirmCheckout = defineOperation({
  name: 'billing_confirm_checkout',
  description:
    'After the provider’s checkout page returns: apply the subscription it created. Answers pending: true while the ' +
    'provider is still creating it; ask again in a few seconds.',
  input: z.object({ organizationId: id, session: z.string().min(8).max(200).regex(/^[A-Za-z0-9_]+$/, 'Not a checkout session id') }),
  http: { method: 'POST', path: '/orgs/:organizationId/billing/checkout/confirm' },
  mcp: false,
  run: ({ env, actor, waitUntil }, input) => confirmCheckout(env, actor, input.organizationId, input.session, waitUntil),
})

export const billingSetSize = defineOperation({
  name: 'billing_set_size',
  description: 'Change Growth’s size (extraHundreds above the included 5,000 people). The difference is charged or credited now.',
  input: z.object({ organizationId: id, extraHundreds }),
  http: { method: 'PUT', path: '/orgs/:organizationId/billing/size' },
  mcp: false,
  run: async ({ env, actor, waitUntil }, input) => ({
    billing: await setSize(env, actor, input.organizationId, input.extraHundreds, waitUntil),
  }),
})

export const billingPortal = defineOperation({
  name: 'billing_portal',
  description: 'A short-lived link into the payment provider’s customer portal: invoices, the card on file, cancelling.',
  input: z.object({ organizationId: id }),
  http: { method: 'POST', path: '/orgs/:organizationId/billing/portal' },
  mcp: false,
  run: ({ env, actor }, input) => portalLink(env, actor, input.organizationId),
})

export const billingUsage = defineOperation({
  name: 'billing_usage',
  description:
    'This month’s plan usage next to the plan’s limits: active audience (emailed and website people), storage, ' +
    'emails sent, mailboxes, domains, agents and website events. null limits are unlimited.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/orgs/:organizationId/billing/usage' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ usage: await getUsage(env, actor, input.organizationId) }),
})

export const billingOperations = [billingGet, billingUsage, billingCheckout, billingConfirmCheckout, billingSetSize, billingPortal]
