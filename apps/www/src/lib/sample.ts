// Sample data for the parts of the dashboard that have no API yet: messages, other members, secrets, billing and
// integrations. Demo mode (/app/?demo, no sign-in) also uses the sample account, domains and mailboxes.
// Replace each export with an API call as the endpoints land.

import type { DnsRecord, Domain, Draft, Mailbox, Org, User } from './types'

/** A time today, or `daysAgo` days back, at hh:mm local time. */
function at(daysAgo: number, hh: number, mm: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hh, mm, 0, 0)
  return d.toISOString()
}

export const sampleUser: User = { id: 'usr_demo', email: 'asif@xstate.com', name: 'Asif Khan' }
export const sampleOrg: Org = { id: 'org_demo', name: 'xstate', role: 'owner', plan: 'Pro' }

export const sampleDomains: Domain[] = [
  { id: 'dom_1', name: 'xstate.com', status: 'verified', enabled: true },
  { id: 'dom_2', name: 'ninjademo.store', status: 'verified', enabled: true },
  { id: 'dom_3', name: 'acme-supply.co', status: 'pending', enabled: true },
]

export const sampleMailboxes: Mailbox[] = [
  { id: 'mbx_1', kind: 'shared', address: 'support@xstate.com', domainId: 'dom_1' },
  { id: 'mbx_2', kind: 'shared', address: 'sales@xstate.com', domainId: 'dom_1' },
  { id: 'mbx_3', kind: 'shared', address: 'hello@ninjademo.store', domainId: 'dom_2' },
  { id: 'mbx_4', kind: 'agent', address: 'orders@ninjademo.store', domainId: 'dom_2' },
  { id: 'mbx_5', kind: 'shared', address: 'help@acme-supply.co', domainId: 'dom_3' },
]

/** DNS records shown under a pending domain in demo mode (the live app gets them from the verify call). */
export const sampleRecords: DnsRecord[] = [
  { type: 'MX', name: '@', value: '10 mx.xstate.io', found: false, required: true },
  { type: 'TXT', name: '@', value: 'v=spf1 include:mail.xstate.com ~all', found: false, required: true },
  { type: 'CNAME', name: 'hn._domainkey', value: 'dkim.xstate.com', found: false, required: true },
]

export type SampleMessage = {
  id: string
  from: { name: string; email: string }
  to: string
  subject: string
  body: string[]
  time: string
  folder: 'inbox' | 'sent' | 'spam'
  pinned?: boolean
  unread?: boolean
  draft?: Draft
}

export function sampleMessages(): SampleMessage[] {
  return [
    {
      id: 'msg_1',
      from: { name: 'Sarah Johnson', email: 'sarah.j@gmail.com' },
      to: 'orders@ninjademo.store',
      subject: 'Order #1234 still not shipped',
      body: [
        'Hi, I placed order #1234 on Friday and the status still says processing. Could you check what is going on?',
        'I need it before the weekend if possible. Thanks, Sarah',
      ],
      time: at(0, 14, 21),
      folder: 'inbox',
      pinned: true,
      unread: true,
      draft: {
        agent: 'Order Tracker',
        from: 'orders@ninjademo.store',
        body:
          'Hi Sarah, your order #1234 left our warehouse this morning with UPS (tracking 1Z999AA10123456784). ' +
          'Expected delivery is Thursday, Nov 5. Sorry for the wait.',
      },
    },
    {
      id: 'msg_2',
      from: { name: 'Tom Williams', email: 'tom.w@outlook.com' },
      to: 'support@xstate.com',
      subject: 'Refund request for damaged item',
      body: [
        'The ceramic vase I received arrived cracked. Photos attached. I would like a refund or a replacement, whichever is faster.',
        'Order #1198. Thanks, Tom',
      ],
      time: at(0, 11, 5),
      folder: 'inbox',
      unread: true,
    },
    {
      id: 'msg_3',
      from: { name: 'Priya Patel', email: 'priya@brightlane.co' },
      to: 'sales@xstate.com',
      subject: 'Pricing for 5 stores',
      body: [
        'We run five Shopify stores and want Ninja on all of them. Is there volume pricing, and can one agent answer for every store?',
        'Happy to jump on a call this week. Priya',
      ],
      time: at(0, 10, 12),
      folder: 'inbox',
      unread: true,
    },
    {
      id: 'msg_4',
      from: { name: 'Carlos Ruiz', email: 'carlos.ruiz@gmail.com' },
      to: 'hello@ninjademo.store',
      subject: 'Discount code not working',
      body: ['The code WELCOME15 says it is invalid at checkout. I signed up for the newsletter yesterday.', 'Carlos'],
      time: at(0, 9, 40),
      folder: 'inbox',
      unread: true,
    },
    {
      id: 'msg_5',
      from: { name: 'Emma Davis', email: 'emma@davisinteriors.com' },
      to: 'sales@xstate.com',
      subject: 'Re: Custom bulk order',
      body: ['Thanks for the quote. We will go ahead with 250 units. Can you send an invoice to accounts@davisinteriors.com?', 'Emma'],
      time: at(1, 16, 30),
      folder: 'inbox',
    },
    {
      id: 'msg_6',
      from: { name: 'Liam Chen', email: 'liam.chen@icloud.com' },
      to: 'orders@ninjademo.store',
      subject: 'Size exchange',
      body: ['Can I swap the medium hoodie for a large? Order #1221. Happy to send it back today.', 'Liam'],
      time: at(3, 12, 2),
      folder: 'inbox',
    },
    {
      id: 'msg_7',
      from: { name: 'Noah Becker', email: 'noah@beckerbikes.de' },
      to: 'support@xstate.com',
      subject: 'WhatsApp integration question',
      body: ['Does the WhatsApp channel support template messages, or only replies inside the 24 hour window?', 'Noah'],
      time: at(3, 9, 15),
      folder: 'inbox',
    },
    {
      id: 'msg_8',
      from: { name: 'Asif Khan', email: 'support@xstate.com' },
      to: 'jordan@acme-supply.co',
      subject: 'Welcome to xstate',
      body: ['Hi Jordan, your invite is on its way. Your new address will be ready as soon as the DNS records are in.'],
      time: at(2, 10, 0),
      folder: 'sent',
    },
    {
      id: 'msg_9',
      from: { name: 'Prize Desk', email: 'winner@lucky-prizes.biz' },
      to: 'hello@ninjademo.store',
      subject: 'You have won a gift card',
      body: ['Click to claim your $500 gift card before midnight.'],
      time: at(4, 3, 12),
      folder: 'spam',
    },
  ]
}

export type Member = { id: string; name: string | null; email: string; role: 'owner' | 'admin' | 'member'; seen?: string; invited?: boolean }
export type Secret = { name: string; usedBy: string; updated: string }
export type Usage = { label: string; used: number; total: number; format: (used: number, total: number) => string }
export type Billing = {
  plan: string
  price: string
  renews: string
  renewsShort: string
  seats: number
  usage: Usage[]
  card: { brand: string; last4: string; expires: string; email: string }
  invoices: { date: string; amount: string }[]
}
export type Integration = { id: string; name: string; glyph: string; connected: boolean; detail?: string; about: string }

export const sampleMembers: Member[] = [
  { id: 'mem_2', name: 'Maya Chen', email: 'maya@xstate.com', role: 'admin', seen: 'Active 2 h ago' },
  { id: 'mem_3', name: 'Sam Ortiz', email: 'sam@ninjademo.store', role: 'member', seen: 'Active yesterday' },
  { id: 'mem_4', name: 'Priya Nair', email: 'priya@xstate.com', role: 'member', seen: 'Active Oct 31' },
  { id: 'mem_5', name: null, email: 'jordan@acme-supply.co', role: 'member', invited: true },
]

export const sampleSecrets: Secret[] = [
  { name: 'SHOPIFY_ADMIN_TOKEN', usedBy: 'Support Ninja, Order Tracker', updated: 'Oct 12' },
  { name: 'STRIPE_SECRET_KEY', usedBy: 'Support Ninja', updated: 'Sep 30' },
  { name: 'SHIPPO_API_KEY', usedBy: 'Order Tracker', updated: 'Sep 18' },
  { name: 'SLACK_WEBHOOK_URL', usedBy: 'Sales Ninja', updated: 'Aug 27' },
  { name: 'ZENDESK_API_TOKEN', usedBy: '', updated: 'Aug 2' },
]

export const sampleBilling: Billing = {
  plan: 'Pro plan',
  price: '$99 / month',
  renews: 'December 1, 2026',
  renewsShort: 'Dec 1',
  seats: 5,
  usage: [
    { label: 'AI tokens', used: 3.2, total: 5, format: (u: number, t: number) => `${u}M of ${t}M` },
    { label: 'Conversations', used: 7412, total: 10000, format: (u: number, t: number) => `${u.toLocaleString('en-US')} of ${t.toLocaleString('en-US')}` },
    { label: 'Storage', used: 42.6, total: 100, format: (u: number, t: number) => `${u} GB of ${t} GB` },
  ],
  card: { brand: 'Visa', last4: '4242', expires: '08/2028', email: 'billing@xstate.com' },
  invoices: [
    { date: 'Nov 1, 2026', amount: '$99.00' },
    { date: 'Oct 1, 2026', amount: '$99.00' },
    { date: 'Sep 1, 2026', amount: '$99.00' },
    { date: 'Aug 1, 2026', amount: '$49.00' },
  ],
}

export const sampleIntegrations: Integration[] = [
  { id: 'shopify', name: 'Shopify', glyph: 'S', connected: true, detail: 'ninjademo.store', about: 'Orders, customers and products' },
  { id: 'whatsapp', name: 'WhatsApp Business', glyph: 'W', connected: true, detail: '+1 415 555 0142', about: 'Customer chats' },
  { id: 'instagram', name: 'Instagram', glyph: 'I', connected: false, about: 'DMs and comment replies' },
  { id: 'messenger', name: 'Facebook Messenger', glyph: 'F', connected: false, about: 'Page inbox replies' },
  { id: 'stripe', name: 'Stripe', glyph: 'S', connected: true, detail: 'Refunds and payment lookups', about: 'Refunds and payment lookups' },
  { id: 'slack', name: 'Slack', glyph: '#', connected: true, detail: '#sales-leads, #support-escalations', about: 'Escalations and alerts' },
  { id: 'zendesk', name: 'Zendesk', glyph: 'Z', connected: false, about: 'Ticket handoff' },
  { id: 'notion', name: 'Notion', glyph: 'N', connected: true, detail: 'Knowledge base pages', about: 'Knowledge base pages' },
]
