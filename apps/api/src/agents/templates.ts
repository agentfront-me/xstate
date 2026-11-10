// Starting points for a new agent (design: New agent → template), and the shape "describe it" drafts into
// (agents/designer.ts). A draft is never saved by itself: the app shows it for review, then creates the agent from
// it (paused, unpublished) and adds the suggested trigger.

import { agentConfig, type AgentConfig } from './config'

/** A trigger to add with the agent. The person picks what only they know (which mailbox; the time zone is theirs). */
export type TriggerDraft =
  | { kind: 'email'; config: { rules: { from: string; subjectContains: string; hasAttachment: boolean | null }; aiFilter: string } }
  | { kind: 'schedule'; config: { frequency: 'daily' | 'weekly'; time: string; weekdays?: number[]; task: string } }
  | { kind: 'webhook'; config: { name: string; template: string } }

export type AgentDraft = {
  template: string | null
  name: string
  description: string
  config: AgentConfig
  trigger: TriggerDraft | null
  /** Something realistic to try in the Test drawer before turning it on. */
  sampleTask: string
  /** What the person should check or fill in before using it. */
  todo: string[]
}

export type TemplateInfo = AgentDraft & { id: string; icon: string; blurb: string }

const config = (c: { instructions: string; builtin: string[]; approval?: Record<string, 'always' | 'never'>; memory?: boolean }): AgentConfig =>
  agentConfig.parse({
    instructions: c.instructions,
    tools: { builtin: c.builtin, approval: c.approval ?? {} },
    memory: { enabled: c.memory ?? false },
  })

export const TEMPLATES: TemplateInfo[] = [
  {
    id: 'support-inbox',
    template: 'support-inbox',
    icon: 'inbox',
    name: 'Support inbox',
    blurb: 'Answers customer questions in a shared mailbox. Replies wait for your approval.',
    description: 'Answers customer questions in the support mailbox.',
    config: config({
      instructions: [
        'You answer customer emails for our company.',
        '',
        'For each email: read the whole thread with email_get_thread, look the sender up in contacts, and search storage for our policies or product details when you need facts.',
        'Reply with email_send as a reply (inReplyTo), in the customer’s language, friendly and under 120 words.',
        'Only state facts you found. If you can’t answer, or the customer is angry or asks for a refund, say a colleague will follow up, and don’t promise anything.',
        'Remember useful facts about a customer (their plan, preferences, open issues) for next time.',
      ].join('\n'),
      builtin: ['email_get_thread', 'email_list_messages', 'email_send', 'audience_get_person', 'audience_list_people', 'storage_search'],
      approval: { email_send: 'always' },
      memory: true,
    }),
    trigger: {
      kind: 'email',
      config: { rules: { from: '', subjectContains: '', hasAttachment: null }, aiFilter: 'A question or request from a customer, not a newsletter, receipt or notification.' },
    },
    sampleTask: 'From: jane@customer.com\nSubject: Can I change my plan?\n\nHi, we are on the monthly plan. Can we switch to yearly, and do we keep our data? Thanks, Jane',
    todo: ['Pick the mailbox it answers.', 'Add your policies to Storage so it can find them, or paste the key facts into the instructions.'],
  },
  {
    id: 'lead-qualifier',
    template: 'lead-qualifier',
    icon: 'user',
    name: 'Lead qualifier',
    blurb: 'Reads new enquiries, checks who they’re from, drafts a reply and pins the good ones.',
    description: 'Qualifies new sales enquiries and drafts replies.',
    config: config({
      instructions: [
        'You qualify new sales enquiries.',
        '',
        'For each enquiry: read the thread, look the sender up in contacts, and judge the fit: company size, need, budget and timing when they say so.',
        'A good fit: pin the message (email_update_message) and create a draft reply that proposes a call. A poor fit: create a short, polite draft that points them to our website.',
        'Never send anything yourself: a person reviews your drafts.',
        'End with one line: “Fit: good / maybe / poor” and why.',
      ].join('\n'),
      builtin: ['email_get_thread', 'audience_get_person', 'audience_list_people', 'email_create_draft', 'email_update_message'],
      memory: true,
    }),
    trigger: {
      kind: 'email',
      config: { rules: { from: '', subjectContains: '', hasAttachment: null }, aiFilter: 'A new sales enquiry: someone asking about buying, pricing, a quote or a demo.' },
    },
    sampleTask: 'From: tom@bigco.example\nSubject: Pricing for 40 seats\n\nHello, we are a 200-person agency looking to move our team email. What would 40 seats cost, and can we start next month? Tom',
    todo: ['Pick the mailbox enquiries arrive in.', 'Describe your ideal customer in the instructions.'],
  },
  {
    id: 'invoice-processing',
    template: 'invoice-processing',
    icon: 'file-text',
    name: 'Invoice processing',
    blurb: 'Picks up emailed invoices, pulls out the key details and files them for finance.',
    description: 'Extracts invoice details from incoming mail for finance.',
    config: config({
      instructions: [
        'You process supplier invoices that arrive by email.',
        '',
        'For each email with an invoice: read the thread and its attachments, and find the supplier, invoice number, amount, currency and due date.',
        'Create a draft to our finance team with those details in a short list, and mark the original email as read.',
        'If something is missing or looks wrong (a changed bank account, an unknown supplier, an amount far from usual), say so at the top of the draft.',
        'End with the details in one line.',
      ].join('\n'),
      builtin: ['email_get_thread', 'storage_search', 'email_create_draft', 'email_update_message'],
    }),
    trigger: {
      kind: 'email',
      config: { rules: { from: '', subjectContains: '', hasAttachment: true }, aiFilter: 'An invoice or bill to be paid.' },
    },
    sampleTask: 'From: billing@supplier.example\nSubject: Invoice INV-2291\n\nPlease find attached invoice INV-2291 for €1,240.00, due 30 November. Bank details unchanged.',
    todo: ['Pick the mailbox invoices arrive in.', 'Put your finance team’s address in the instructions.'],
  },
  {
    id: 'weekly-digest',
    template: 'weekly-digest',
    icon: 'calendar',
    name: 'Weekly digest',
    blurb: 'Every Monday morning, sums up last week’s mail and this week’s meetings for you.',
    description: 'Sends a Monday summary of mail and meetings.',
    config: config({
      instructions: [
        'You write a short weekly digest.',
        '',
        'List the last 7 days of mail, read the threads that matter, and check this week’s calendar.',
        'Write: what needs a reply (who and what), important news, decisions made, and this week’s meetings. Bullet points, under 250 words.',
        'Send it with email_send to the address in these instructions, and to no one else.',
      ].join('\n'),
      builtin: ['email_list_messages', 'email_get_thread', 'calendar_list_events', 'email_send'],
      approval: { email_send: 'always' },
    }),
    trigger: { kind: 'schedule', config: { frequency: 'weekly', time: '08:00', weekdays: [1], task: 'Write and send this week’s digest.' } },
    sampleTask: 'Write this week’s digest, but don’t send it: show me what it would say.',
    todo: ['Add the address the digest goes to, in the instructions.', 'Pick the mailbox it reads in Settings → Mailboxes.'],
  },
]

export const findTemplate = (id: string) => TEMPLATES.find((t) => t.id === id) ?? null
