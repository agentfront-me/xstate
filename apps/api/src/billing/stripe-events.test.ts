import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'
import { formEncode, LOOKUP, toEvents, toSubscription, verifyStripeSignature, type StripeEvent } from './stripe-events.ts'

const secret = 'whsec_test'
const sign = (payload: string, t: number) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`

describe('verifyStripeSignature', () => {
  const payload = '{"id":"evt_1"}'
  const now = 1_800_000_000
  it('accepts a valid, recent signature', async () => {
    assert.equal(await verifyStripeSignature(secret, sign(payload, now), payload, now), true)
  })
  it('accepts when any v1 matches', async () => {
    assert.equal(await verifyStripeSignature(secret, `${sign(payload, now)},v1=deadbeef`, payload, now), true)
  })
  it('rejects a changed body, a wrong secret and an old timestamp', async () => {
    assert.equal(await verifyStripeSignature(secret, sign(payload, now), '{"id":"evt_2"}', now), false)
    assert.equal(await verifyStripeSignature('whsec_other', sign(payload, now), payload, now), false)
    assert.equal(await verifyStripeSignature(secret, sign(payload, now - 301), payload, now), false)
    assert.equal(await verifyStripeSignature(secret, 'garbage', payload, now), false)
  })
})

const sub = {
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  metadata: { organizationId: 'org_1' },
  start_date: 1_700_000_000,
  cancel_at_period_end: false,
  items: {
    data: [
      { id: 'si_base', quantity: 1, current_period_end: 1_800_000_000, price: { id: 'price_b', lookup_key: LOOKUP.base } },
      { id: 'si_extra', quantity: 50, current_period_end: 1_800_000_000, price: { id: 'price_e', lookup_key: LOOKUP.extra } },
    ],
  },
}

describe('toSubscription', () => {
  it('reads size, period end and organization from the newer API shape', () => {
    const s = toSubscription(sub, '2026-11-19T00:00:00.000Z')
    assert.equal(s.extraHundreds, 50)
    assert.equal(s.organizationId, 'org_1')
    assert.equal(s.periodEnd, new Date(1_800_000_000_000).toISOString())
    assert.equal(s.cancelAt, null)
    assert.equal(s.status, 'active')
  })
  it('has no extra hundreds without that item, and maps unpaid to paused', () => {
    const s = toSubscription({ ...sub, status: 'unpaid', items: { data: [sub.items.data[0]!] } }, 'x')
    assert.equal(s.extraHundreds, 0)
    assert.equal(s.status, 'paused')
  })
  it('treats cancel at period end as a scheduled cancellation', () => {
    const s = toSubscription({ ...sub, cancel_at_period_end: true }, 'x')
    assert.equal(s.cancelAt, s.periodEnd)
  })
})

const ev = (type: string, object: unknown): StripeEvent => ({ id: 'evt_1', type, created: 1_800_000_000, data: { object } })

describe('toEvents', () => {
  it('turns subscription events into subscriptions, timed by the event', () => {
    const [e] = toEvents(ev('customer.subscription.updated', sub))
    assert.equal(e?.kind, 'subscription')
    if (e?.kind === 'subscription') assert.equal(e.subscription.updatedAt, new Date(1_800_000_000_000).toISOString())
  })
  it('turns a paid invoice into revenue less tax, both API shapes', () => {
    const [older] = toEvents(ev('invoice.paid', { id: 'in_1', customer: 'cus_1', currency: 'usd', amount_paid: 5390, tax: 490, billing_reason: 'subscription_create', subscription: 'sub_1' }))
    assert.deepEqual(older && older.kind === 'payment' && [older.amount, older.reason, older.subscriptionId], [4900, 'new', 'sub_1'])
    const [newer] = toEvents(
      ev('invoice.paid', {
        id: 'in_2',
        customer: 'cus_1',
        currency: 'usd',
        amount_paid: 9900,
        total_taxes: [],
        billing_reason: 'subscription_cycle',
        parent: { subscription_details: { subscription: 'sub_1', metadata: { organizationId: 'org_1' } } },
      }),
    )
    assert.deepEqual(newer && newer.kind === 'payment' && [newer.amount, newer.reason, newer.organizationId], [9900, 'renewal', 'org_1'])
  })
  it('maps failed payments and refunds, and ignores the rest', () => {
    const [failed] = toEvents(ev('invoice.payment_failed', { id: 'in_3', amount_due: 4900 }))
    assert.equal(failed?.kind === 'payment' && failed.status, 'failed')
    const [refund] = toEvents(ev('charge.refunded', { id: 'ch_1', amount_refunded: 4900, refunded: true, payment_intent: 'pi_1', customer: 'cus_1' }))
    assert.deepEqual(refund && refund.kind === 'payment' && [refund.status, refund.paymentId, refund.fullRefund], ['refunded', 'pi_1', true])
    assert.deepEqual(toEvents(ev('customer.created', {})), [])
  })
})

describe('formEncode', () => {
  it('nests objects and arrays the way Stripe expects', () => {
    const s = decodeURIComponent(formEncode({ mode: 'subscription', line_items: [{ price: 'p', quantity: 1 }], metadata: { organizationId: 'o' }, skip: undefined }))
    assert.equal(s, 'mode=subscription&line_items[0][price]=p&line_items[0][quantity]=1&metadata[organizationId]=o')
  })
})
