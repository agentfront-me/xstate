# Plan: billing on Stripe and plan limits

Status: **approved 2026-11-19. Phases 1–3 pushed (7c5c3fa; that deploy failed on the missing Stripe secrets). Phase 5
built 2026-11-19, uncommitted. Phase 4 (measuring) skipped at the user's request (not live yet). Phase 6 (docs) built 2026-11-19, uncommitted.**

**Phase 6, as built:** Terms §4 rewritten (priced by people reached, limits and the 10% grace, monthly billing in
advance, HireNinja LLC sells, Stripe processes, taxes added where the law requires); Refund Policy (no Paddle,
monthly renewals, size changes, ask by email, invoices in Manage billing); Privacy (Stripe as processor, plan usage
counts and their retention, a lawful-basis row); `security.md` (Stripe checkout and signature check); site pricing
footnote; the data-export FAQ no longer mentions IMAP; changelog `2026-11-19.md`. Not legal advice: have the Terms,
Privacy and Refund changes reviewed, especially tax wording now that there is no merchant of record.

**Phase 5, as built:**
- `limits/index.ts`: `planOf`, `requireRoom` (mailboxes, domains, agents), `requireStorageRoom`, `requireEmailRoom`,
  `audiencePaused`; errors are 402 `plan_limit` (429 `send_limit_reached` for emails). `limits/rules.ts` holds the
  pure parts (grace, pause flag, ISO week, `decide`; tested). Counted limits allow 10% rounded down, so 5 mailboxes,
  3 domains and 1 agent stop exactly there; storage stops over 110%; emails a month stop at 100%.
- Checked in: `createMailbox` (personal + shared), `addMember` and the Google import (before anyone is invited),
  `addDomain`, `agents.create` (and duplicate), `reserveSend` (system mail from SYSTEM_MAIL_FROM is exempt),
  Storage `uploadFile`, `writeContent`/`writeText`, `restoreVersion`, `saveAttachment`. Mail always keeps arriving.
- `limits/hourly.ts` (hourly cron): Free notices at 100% and 110% (audience, storage, emails), once a month each;
  over 110% of the audience sets `org_usage.over_since.audiencePaused` for the month, which pauses the email API
  (`emails/service.ts`), agent runs (`AgentStore.startRun`, recorded as skipped) and identify calls on `/v1/collect`.
  Only Free pauses; an upgrade lifts it at once. Growth at or over its size: an email to owners and admins every ISO
  week; nothing stops. Notices come from the system mailbox; `org_usage.notified` keeps them to once per period.
- `limits/search-cap.ts`: Growth's internal cap of 100 searchable emails per person of its paid size; over it, the
  emails indexed longest ago leave AI search (up to 2,000 an hour per organization). By `indexed_at`, since
  search_docs has no email date.
- Settings → Billing shows a banner while paused. Still not decided: automatic size increases for Growth (only the
  weekly email is built).
- Custom by hand: `UPDATE organizations SET plan = 'custom', limits_override = '{"audience":2000000,"storageBytes":5000000000000}' WHERE id = '…'`
  (unset keys are unlimited).
- Tested locally on a Free org: 6th mailbox, 4th domain, 2nd agent, a send past 4,000 and an upload over 5 GB were
  refused with their messages; the hourly pass sent the storage and email notices once. Not tested: an agent run while
  paused (the local agent has no model), the email API while paused, the search cap on real data.

**Phase 3, as built (counting only, nothing refused):**
- Active audience: AudienceStore upgrade 7, tables `active_people(month, email, source)` and `usage_months(month,
  events)`. `recordActive` is fed by the mail-events queue (`mailbox/events.ts`) with every address in From, To, Cc,
  Bcc of each sent or received message not in Junk (not imports or caught-up mail); `collect` adds identified visitors
  (`source = 'web'`) and counts accepted website events per month. The daily alarm keeps 3 months of people and two
  years of event counts.
- D1 migration `0046_org_usage.sql`: `org_usage` (`mail_bytes`, `mail_checked_at`, `emails_month`, `emails_count`,
  and `over_since` / `notified` for phase 5) and the index `search_docs(organization_id, status)`.
- Storage: raw mail bytes added per message by the mail-events queue; `recountMail` sums each mailbox's
  `MailboxStore.mailBytes()`, daily at 03:00 UTC and when the usage page finds the count over 6 hours old. Storage
  files (`files.source = 'drive'`, all kept versions) are summed live; attachment copies are not counted twice.
- Emails a month: `reserveSend` adds every distinct recipient to `org_usage.emails_count` in its own batch and takes
  it back on release. Calendar invitations count too (they go through `reserveSend`).
- `limitsFor(plan, extraHundreds, override)` in `billing/plans.ts`; operation `billing_usage`; Settings → Billing
  shows "Usage in <month>" with bars (people reached split by email and website, storage, emails, mailboxes,
  domains, agents, website events).
- Tested locally: two fake inbound emails and one reply with a Cc counted 4 people and 2 emails, and grew storage.
  Not tested: an identified website visitor counting (code path only).

**Phase 2, as built:** `billing/stripe.ts` (REST with fetch, prices found by lookup key, Checkout, Customer Portal,
`setExtraHundreds` with `always_invoice` proration, webhook) and `billing/stripe-events.ts` (Stripe objects →
neutral types, Stripe-Signature check; tested). `scripts/billing-catalog.mjs` creates the product, the prices
`xstate_growth_base` ($49) and `xstate_growth_extra_100` ($1) and a portal configuration (`metadata.xstate=growth`);
run in test mode 2026-11-19. Added `billing_confirm_checkout`: the return link carries `?checkout_session=…` and the
app applies the subscription at once, so local testing needs no webhook. Secrets `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` are required in wrangler.jsonc (wrangler dev only loads required ones); a value not starting
`sk_` / `whsec_` (e.g. `off`) keeps billing unavailable. Tested locally in test mode: checkout at 10,000 people
($99), size up to 25,000 ($249) and down to 5,000 ($49, removes the extra item), portal link. Not tested: a real
webhook delivery (no Stripe CLI here); covered by unit tests only.

Webhook events to enable on the Stripe endpoint `https://api.xstate.com/webhooks/billing/stripe`:
`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`,
`invoice.payment_failed`, `charge.refunded`.

**Phase 1, as built:** `billing/provider.ts` (interface, `providerFor` answers null until phase 2), provider-free
`plans.ts`, `service.ts` (`getBilling`, `startCheckout`, `setSize`, `portalLink`, `applySubscription`,
`billingHourly`), `webhook.ts` at `POST /webhooks/billing/:provider`, `analytics.ts` `recordPayment`; operations
`billing_get`, `billing_checkout`, `billing_set_size`, `billing_portal`; migration `0045_billing_neutral.sql`;
`BILLING_PROVIDER: "stripe"` in wrangler.jsonc. Removed: `paddle.ts`, `ips.ts`, `scripts/paddle-catalog.mjs`, the
seat syncs, `@paddle/paddle-js`, the `?_ptxn=` redirect, Paddle vars and required secrets. Settings → Billing and the
go.xstate.com front page show the new plans. Money analytics events now carry `size` instead of `interval`/`seats`
(docs/analytics-events.md updated).

**Decisions (user, 2026-11-19), answering §2:**
1. No sales tax for now (no Stripe Tax at launch).
2. Billed in advance (the two-item subscription).
3. Monthly only at launch.
4. Free over 110% of its audience: as recommended (person-to-person mail keeps working; API sends, agent runs and
   new identified visitors pause).
5. Storage over 110%: as recommended (mail keeps arriving; uploads and new files are blocked).
6. When a Growth org is full, email the owners **every week** while it stays full. (Whether the size is also raised
   automatically is to confirm in phase 5.)
7. Website event load: build the tracking, but deciding and enforcing an allowance comes later.
8. Custom is sold by hand.
 Pricing decisions are in `docs/pricing-plan.md` §8a; this
document is how to charge for them and enforce them.

What it covers:

1. Remove the Paddle per-person billing.
2. Charge for the audience-based plans (Free, Growth, Custom) through Stripe.
3. Keep billing behind one interface, so moving back to Paddle (or another provider) means writing one file.
4. Count usage and enforce each plan's limits, with the decided 10% grace.

---

## 1. Where things stand

- **Paddle billing** is about 900 lines in `apps/api/src/billing/`:
  - `paddle.ts`, `plans.ts`, `service.ts`, `webhook.ts`, `ips.ts`, `analytics.ts`
  - migration `0031_billing.sql`, `scripts/paddle-catalog.mjs`
  - `apps/app/src/settings/Billing.tsx`, and Paddle.js in `apps/app/public/index.html`
  - config in `wrangler.jsonc` and `.dev.vars.example`
- **Production has no paid subscribers.** Both orgs are on `free` with no subscription (checked 2026-11-19), so removing Paddle needs no customer migration.
- **No per-plan usage limit exists anywhere.** The only checks today:
  - sending abuse caps (`reserveSend`: 100/h and 500/day per mailbox, 400/h and 2,000/day per org, outside recipients only)
  - calendar invitation caps
  - per-agent limits that people set themselves
  - per-file size caps (100 MB)
- **`organizations.plan`** is read outside billing in one place only: `db/members.ts:31`, for the plan name shown by `getMe()`.

---

## 2. Decisions needed before building

These came up while planning. My recommendation comes first in each.

1. **Sales tax and VAT.** Paddle was a merchant of record: it registered, charged and filed tax everywhere. Stripe
   doesn't, so HireNinja LLC becomes responsible for sales tax and VAT.
   - **Recommended:** turn on Stripe Tax (0.5% of each payment). It calculates and collects tax in Checkout and on invoices, and shows where you've crossed a registration threshold. Filing stays with you (or a filing service).
   - Alternative: collect no tax at first. That's risky for EU and UK customers.
2. **How Growth is charged.**
   - **Recommended:** a subscription with **two items**: "Growth" at $49 × 1, plus "Extra 100 people" at $1 × n. Billed monthly in advance.
     - The org picks its size, either on the slider or as the automatic upgrade below.
     - Both Stripe and Paddle support multi-item subscriptions with quantities, which keeps the provider switch easy.
   - Alternative: Stripe usage-based (metered) billing, charging each month afterwards for the real audience. It's fairer, but bills change every month, the first bill comes a month late, and Paddle has nothing equivalent.
3. **Yearly billing.** Recommended: monthly only at launch, as Loops does. Yearly can come later as a second price per item.
4. **What happens when Free goes over 110% of its 1,000 active audience.** Mail from and to new people can't be stopped without breaking email.
   - **Recommended:** keep all person-to-person mail working. Pause email API sends and agent runs, and stop adding new identified website visitors, until the next month or an upgrade.
5. **What happens when storage goes over 110%.** SES accepts every message before xstate sees it, so the "452 mailbox full" in `pricing-plan.md` §7 isn't possible.
   - **Recommended:** keep receiving and storing mail, but block uploads and new Storage files, and show a banner. Mail is never lost.
   - Alternative: hold new mail out of the inbox until there's space. That's safer for cost but confusing for people.
6. **Growth auto-upgrade.** When an org stays over 110% of its Growth size for two months in a row, raise its "extra 100s" quantity to fit. Notices go out at 100% and 110%.
   - Recommended: yes, as decided in §8a, with the owner emailed the new price first.
7. **Website event allowance.** Still open in §8a.
   - Recommended for now: no event limit; watch the AudienceStore's rows written per org instead.
8. **Custom plan.** Recommended: sold by hand. You create the Stripe subscription or quote yourself, and an admin sets that org's limits in D1. No self-serve checkout.

---

## 3. Design

### 3.1 One billing interface, Stripe behind it

New `apps/api/src/billing/` layout:

| File | What it does |
|---|---|
| `provider.ts` | The `BillingProvider` interface and provider-neutral types |
| `stripe.ts` | The Stripe implementation (REST calls with `fetch`, webhook signature check with Web Crypto) |
| `plans.ts` | Plans, prices, limits per plan, `planFor(subscription)` (no provider code) |
| `service.ts` | Billing view, checkout, size change, portal, applying subscription updates (no provider code) |
| `webhook.ts` | `POST /webhooks/billing/:provider`: verifies with the provider, then hands neutral events to `service.ts` |
| `analytics.ts` | Order Completed / Payment Failed / Order Refunded from neutral payment events (kept, made neutral) |

The interface:

```ts
interface BillingProvider {
  name: 'stripe' | 'paddle'
  checkout(org, { extraHundreds, returnUrl }): Promise<{ url: string }>          // hosted checkout page
  portal(org, returnUrl): Promise<{ url: string }>                              // invoices, card, cancel
  setExtraHundreds(subscriptionId, n): Promise<Subscription>                   // prorated now
  getSubscription(id): Promise<Subscription>
  verifyWebhook(request): Promise<BillingEvent[]>                               // throws on a bad signature
}
type Subscription = { id; customerId; status: 'active'|'trialing'|'past_due'|'canceled'|'paused';
                      extraHundreds: number; periodEnd: string; cancelAt: string | null; updatedAt: string }
type BillingEvent = { kind: 'subscription'; subscription: Subscription; orgId: string | null }
                  | { kind: 'payment'; status: 'paid'|'failed'|'refunded'; amountCents; currency; orgId; id }
```

Nothing outside `stripe.ts` imports Stripe's types or ids. Which provider is used comes from `BILLING_PROVIDER` (default `stripe`), so a Paddle return is a `paddle.ts` file plus a config change.

**Stripe pieces:**

- Products and prices are created by `scripts/billing-catalog.mjs`, idempotent and keyed by `lookup_key`:
  - `xstate_growth_base` at $49 a month
  - `xstate_growth_extra_100` at $1 a month
- Checkout uses Stripe Checkout (a hosted page, redirect) with `client_reference_id = orgId` and both items. Stripe Tax is on if decided (§2.1).
- The Customer Portal handles invoices, the card on file and cancelling. Size changes go through xstate's own API, not the portal, so the slider stays the one place to choose a size.
- Webhooks: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`.
- Config:
  - secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
  - var `STRIPE_PRICES` (the two price ids)
  - test-mode keys in `.dev.vars`
  - no browser key, because Checkout is a redirect
- No SDK. About 150 lines of `fetch` keeps the Worker small, and the signature check is HMAC-SHA256 over `t.payload`, as the Paddle one is today.

### 3.2 Data model (D1)

Migration `00xx_billing_neutral.sql`:

- `organizations`:
  - `plan` CHECK becomes `('free','growth','custom')`; existing rows are all `free`
  - Paddle columns are renamed to neutral ones: `billing_provider`, `billing_customer_id`, `billing_subscription_id`, `subscription_status`, `current_period_end`, `cancel_at`, `billing_event_at`
  - `billed_seats` becomes `extra_hundreds` (Growth's paid size above 5,000)
  - `billing_interval` is dropped (monthly only)
  - `limits_override` (JSON, nullable) holds Custom limits set by an admin
- New `org_usage` table, one row per organization:
  - `storage_bytes`, `storage_checked_at`
  - `emails_month`, `emails_count`
  - `over_since` (JSON per limit), `notified` (JSON per limit and level)
- Active audience is not in D1: it lives in each org's AudienceStore (§3.3).

### 3.3 Counting usage

| Usage | Where it's counted | How |
|---|---|---|
| **Active audience** (per calendar month) | New table `active_people(month, email)` in the org's **AudienceStore** Durable Object, `INSERT OR IGNORE` | (1) every non-Junk message delivered (`mailbox/receive.ts deliverTo`) or sent (`mailbox/outbound.ts sendFromStore`, calendar `sendInvites`): all addresses in From, To, Cc, Bcc; (2) an identified visitor's event in `AudienceStore.collect` (a person with an email). The count is `COUNT(*) WHERE month = ?`. Rows older than 3 months are pruned by the store's daily alarm. Calls ride the existing mail-events queue, so mail delivery never waits on it |
| **Storage bytes** | `org_usage.storage_bytes` | Raw mail size is added in `deliverTo` and subtracted when mail is purged. Files are added and subtracted in `storeVersion` and the trash purge. A nightly recount (sum of `files.size_bytes`, minus attachment copies, plus each mailbox's `rawStats()`) fixes drift |
| **Emails a month** (Free: 4,000, counted per recipient) | `org_usage.emails_count` for the current `emails_month` | Added in `reserveSend` alongside the existing hourly and daily checks. All recipients count, not only outside ones, since the limit is per recipient |
| **Mailboxes, domains, agents** | Counted live from D1 when one is created | `COUNT(*)` on `mailboxes` (personal and shared together), `domains`, `agents` |
| **Searchable emails** (Growth: 100 × active audience, internal) | `search_docs` in D1 | Needs a new index on `search_docs(organization_id, status)` |

### 3.4 Enforcing limits

One module, `apps/api/src/limits/`:

- `limitsFor(org)` returns each limit for the org's plan and size (or its `limits_override`).
- `check(env, orgId, kind, adding)` returns `ok`, `warn` (100–110%) or `stop` (over 110%), and throws a 402 `plan_limit` error with a plain message on `stop`.

Where each check goes:

| Limit | Free | Growth | Checked in | At "stop" |
|---|---|---|---|---|
| Mailboxes | 5 (personal + shared) | unlimited | `mailserver/mailboxes.ts createMailbox` (covers members, API and Google import) | New mailbox refused; the import reports which ones it skipped |
| Domains | 3 | unlimited | `mailserver/domains.ts addDomain` | Refused |
| Agents | 1 | unlimited | `agents/service.ts create` (and `duplicate`) | Refused |
| Emails a month | 4,000 recipients | unlimited (abuse caps stay) | `mailserver/sending.ts reserveSend` | 429 `send_limit_reached` with a plan message. No grace: sending caps stay hard (§8 of the pricing plan) |
| Storage | 5 GB | 50 GB + 1 GB per extra 100 | `storage/drive.ts storeVersion` and `saveAttachment` | Uploads and saves refused; mail keeps arriving (§2.5) |
| Active audience | 1,000 | 5,000 + 100 × extra | Hourly check, not inline | Free: §2.4. Growth: auto-upgrade after two months (§2.6) |
| Searchable emails | no cap | 100 × active audience | `search/indexer.ts indexEmails` skips new emails over the cap; the hourly sweep drops the oldest | Older mail leaves AI search, silently on the site, explained in the app |

Grace: limits that are checked inline allow up to 110% of the limit, except sending. Notices go to owners and admins at 100% and 110%, once per limit per month (`org_usage.notified`), sent from the system mailbox (`mailserver/system-mail.ts`).

The hourly job (in `billingHourly`, replacing `syncSeats`) runs for every org with activity in the last day:

- reads the audience count
- updates `over_since`
- sends notices
- applies the Growth auto-upgrade through `provider.setExtraHundreds`

### 3.5 App (Settings → Billing)

`Billing.tsx` is rewritten. It shows:

- **The plan and price**, and the next payment date.
- **Usage bars:** active audience this month, split into emailed people and website people; storage; mailboxes; domains; agents; and emails this month on Free.
- **A size slider**, the same steps as xstate.com: Upgrade opens Stripe Checkout, and a size change applies at once with proration.
- **A "Manage billing" link** to the Stripe Customer Portal.
- **Notices** at 100% and 110%.

`main.tsx` drops its Paddle `?_ptxn=` handling; checkout returns to `/app/settings/billing?checkout=done`. Banners
for "plan limit reached" come from the 402 `plan_limit` errors.

---

## 4. Build phases

Each phase is reviewable and deployable alone. Limits are off until phase 5, so nothing blocks customers early.

1. **Remove Paddle and add the interface.**
   - Delete: `paddle.ts`, `ips.ts` and its test, `scripts/paddle-catalog.mjs`, Paddle.js, the `_ptxn` handling, the Paddle vars and secrets.
   - Add `provider.ts` and the neutral migration. Make `service.ts`, `webhook.ts` and `analytics.ts` neutral.
   - Billing shows "Free" only until phase 2.
2. **Stripe.**
   - `stripe.ts`, `scripts/billing-catalog.mjs`, checkout, portal, webhook, size change, analytics money events.
   - Settings → Billing with checkout and portal, without usage bars yet.
   - Tested end to end in Stripe test mode, including webhooks via `stripe listen`.
3. **Usage counting.**
   - The `active_people` table in AudienceStore, the `org_usage` counters, the nightly storage recount and the `search_docs` index.
   - Usage bars in Billing. Read-only: no enforcement.
4. **Measure.** One to two weeks of real counts on production. Check the active-audience figures against the 2026-11-19 measurement (~80 per personal mailbox) before anything is refused.
5. **Enforcement.**
   - `limits/` with the checks in §3.4, the grace, the notices and the hourly job with the Growth auto-upgrade.
   - The search cap.
   - The `limits_override` admin path for Custom.
6. **Docs and site.**
   - Terms §4 and the refunds page: Stripe and HireNinja LLC replace "Paddle, our reseller".
   - Privacy: Stripe as a processor in place of Paddle.
   - `security.md`, as required with every security change.
   - The marketing footnote ("Payments are handled by Paddle").
   - `analytics-events.md`, and a changelog entry.

**What you do outside the code:**

- create the Stripe account (test mode first) and give me test keys for `.dev.vars`
- turn on Stripe Tax if decided
- set the live secrets
- add the live webhook endpoint
- remove the Paddle webhook destination and API key, and delete the Worker secrets `PADDLE_API_KEY` and `PADDLE_WEBHOOK_SECRET`

---

## 5. Risks and notes

- **Counting active audience on every message adds writes.** One `INSERT OR IGNORE` per address per message, in the org's AudienceStore, through the existing mail-events queue. At ~1,700 messages a month for the main org that's negligible. Large orgs should batch per message.
- **One AudienceStore per org** handles this volume easily up to Growth sizes. Custom-size orgs (1M+ people) need a different store for counting (`pricing-plan.md` §8a).
- **Stripe without a merchant of record** shifts refunds, chargebacks, tax and invoicing compliance to HireNinja LLC (§2.1).
- **The site already advertises Growth.** Until phase 2 ships, "Get Growth" only leads to sign-up.
