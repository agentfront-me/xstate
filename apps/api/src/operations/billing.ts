// Settings → Billing: the organization's plan, checkout, plan changes and Paddle's customer portal (billing/).
// All off MCP: a connected app or agent must never buy or change a plan.

import { z } from 'zod'
import { changePlan, confirmCheckout, getBilling, portalLinks } from '../billing/service'
import { defineOperation } from './define'

const id = z.string().min(1).max(64)

export const billingGet = defineOperation({
  name: 'billing_get',
  description:
    'The organization’s plan (free, pro or team), billing interval, subscription status, seats billed and people ' +
    'counted, the period end and any scheduled change, list prices, and for owners and admins without a paid plan ' +
    'what the browser needs to open Paddle checkout.',
  input: z.object({ organizationId: id }),
  http: { method: 'GET', path: '/orgs/:organizationId/billing' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ billing: await getBilling(env, actor, input.organizationId) }),
})

export const billingConfirmCheckout = defineOperation({
  name: 'billing_confirm_checkout',
  description:
    'After Paddle checkout completes in the browser: apply the subscription it created. Answers pending: true ' +
    'when Paddle hasn’t created it yet; ask again in a few seconds.',
  input: z.object({ organizationId: id, transactionId: z.string().regex(/^txn_[a-z0-9]{10,40}$/, 'Not a Paddle transaction id') }),
  http: { method: 'POST', path: '/orgs/:organizationId/billing/checkouts/:transactionId/confirm' },
  mcp: false,
  run: ({ env, actor }, input) => confirmCheckout(env, actor, input.organizationId, input.transactionId),
})

export const billingChangePlan = defineOperation({
  name: 'billing_change_plan',
  description: 'Switch the paid plan (pro or team) or interval (month or year). The difference is charged or credited now.',
  input: z.object({ organizationId: id, plan: z.enum(['pro', 'team']), interval: z.enum(['month', 'year']) }),
  http: { method: 'PUT', path: '/orgs/:organizationId/billing/plan' },
  mcp: false,
  run: async ({ env, actor }, input) => ({
    billing: await changePlan(env, actor, input.organizationId, input.plan, input.interval),
  }),
})

export const billingPortal = defineOperation({
  name: 'billing_portal',
  description: 'Short-lived links into Paddle’s customer portal: invoices, update the payment method, cancel.',
  input: z.object({ organizationId: id }),
  http: { method: 'POST', path: '/orgs/:organizationId/billing/portal' },
  mcp: false,
  run: ({ env, actor }, input) => portalLinks(env, actor, input.organizationId),
})

export const billingOperations = [billingGet, billingConfirmCheckout, billingChangePlan, billingPortal]
