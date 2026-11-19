# Plan: xstate pricing

Status: **plans decided 2026-11-16** (§8). Paddle billing built 2026-11-16 (§7); usage limits not built yet.
Costs refreshed 2026-11-19 after Stalwart was removed (§2–§3, §5); analytics event limits proposed, not decided (§3a).
**New direction 2026-11-19:** price by monthly active audience, Loops-style (§8a). The metric is decided; tiers and
limits are open. §1 and §8 still describe the per-person plans built in Paddle.
The dedicated-server question is postponed.

Each plan below says what it includes, its limits, its price and its margin. The margins come from what xstate
pays to run (§2–§4). Prices were read from the providers' pricing pages on 2026-11-16 (§9). Usage figures are
measured on production where possible.

---

## 1. Summary of the recommendation

| | **Free** | **Pro** | **Team** |
|---|---|---|---|
| Price | $0 | **$6** per person a month, or **$5** billed yearly | **$12** per person a month, or **$10** billed yearly |
| People (mailboxes that sign in) | up to 5 | unlimited | unlimited |
| Domains | 1 | 10 | unlimited |
| Shared addresses (hello@, support@) and aliases | 5 | unlimited, no seat charge | unlimited, no seat charge |
| Storage (mail plus files) | 5 GB per person, and 5 GB of org files | 30 GB per person, pooled | 200 GB per person, pooled |
| Mail that AI search covers | **last 90 days** | all mail, up to **50,000 emails per person**, pooled | up to **200,000 emails per person**, pooled |
| Connected AI apps (MCP) | yes, 200 tool calls a day per person | 2,000 a day per person | 10,000 a day per person |
| Agents (on your own AI key) | **no** | 10 agents, 500 runs a month per person, pooled | unlimited agents, 2,000 runs a month per person, pooled |
| Outside recipients a day | 100 per mailbox, 300 per org | 500 per mailbox, 2,000 per org (today's limits) | 1,000 per mailbox, 10,000 per org |
| Google Workspace import | yes (search covers the last 90 days) | yes, fully indexed | yes, fully indexed |
| File version history | 5 versions × 30 days (today) | 5 × 30 days | 100 versions × 1 year |
| Website analytics events a month (proposed) | 10,000 per org | 25,000 per person, pooled | 100,000 per person, pooled |
| Extra storage | – | $5 per 100 GB a month | $5 per 100 GB a month |
| Extra analytics events (proposed) | – | $5 per 100,000 a month | $5 per 100,000 a month |
| Support | docs | email, 1 business day | email, 4 hours |
| **Gross margin, typical person** | costs about $0.19 a month | **about 78%** | **about 84%** |
| **Gross margin, heaviest person at the caps** | costs up to about $1.00 a month | **about 45%** (37% yearly) | about 15% (pooling makes this rare) |

The recommendation in brief:

- **Price per person, and charge nothing extra for shared mailboxes.** Pro at $6 a month undercuts Google
  Business Starter and Microsoft 365 Business Basic, which are both $8.40 a month or $7 billed yearly. It matches
  Fastmail Standard, and xstate also includes agents and connected AI apps.
- **The free plan is real business email, but AI search only covers the last 90 days.** Keeping mail searchable
  is the one mail cost that grows without limit (§3). Free has no agents, which was decided earlier.
- **Limit website analytics events per month (proposed).** They are the other large variable cost, about $15.50
  per million events, and they come from the customer's visitors, not their people (§3a). Contacts and searches
  cost too little to limit.
- **Launch all three plans (decided).** For now Team is Pro with higher limits, longer version history and
  faster support. SSO, 2FA and an audit log join Team when they are built.
- **Fix the marketing page before launch.** `apps/web/app/(marketing)/controls.tsx` shows placeholder plans: Free,
  Pro at $8, Team at $24. It promises things that don't exist (Sites, a Data API, an audit log, a free
  you.xstate.email subdomain) and gives the free plan an agent, which the agents plan rules out.

---

## 2. What xstate pays: fixed costs

Refreshed 2026-11-19. Stalwart stopped on 2026-11-18, so deepo is no longer an xstate cost.

| Item | Monthly | Notes |
|---|---|---|
| Cloudflare Workers Paid | $5.00 | Includes 10M requests, 30M CPU-ms, 1M queue operations, D1/DO/KV allowances (Durable Objects: 50M SQLite rows written and 5 GB stored), 50M queried and 10M stored Vectorize dimensions, and Workflows allowances |
| Amazon SES base | $0 | Pay as you go, no monthly fee, for both sending and receiving |
| Paddle | $0 | Fees per payment only (§4) |
| **Total** | **about $5** | Covered by about one Pro person (§5) |

There is no server to scale any more: all mail runs on Workers, Durable Objects, R2 and SES, so cost grows with
use rather than in steps. (Until 2026-11-18 deepo, an EC2 t3.medium at about $36 a month, ran Stalwart, Postgres
and ClamAV, and the model added about $0.08 per mailbox for it.)

---

## 3. What xstate pays: per organization

An organization's costs grow with six things. Two of them matter: **mail kept searchable** and **website analytics
events**. The rest are small or close to free.

| What grows | Cost | Matters? |
|---|---|---|
| Mail kept searchable (vectors) | ~$0.028 per 1,000 emails, **every month**, plus $0.013 once to index | **Biggest for mail.** About 75% of variable cost today, and it never stops growing |
| Website analytics events | ~$15.50 per million events (§3a) | **Biggest for websites.** Not limited by any plan yet |
| Storage: mail and files in R2 | ~$0.002 per 1,000 emails a month; $0.015 per GB of files | Small, but it grows without limit |
| Received mail (SES) | ~$0.20 per 1,000 | Small |
| Sent mail (SES) | ~$0.15 per 1,000, plus $0.12 per GB of attachments | Small; sending caps already limit it |
| Mailbox index (MailboxStore Durable Objects) | ~2.2 KB per email at $0.20 per GB-month | Free for now: inside the account's included 5 GB |
| Contacts (AudienceStore) | ~1 KB each; 10,000 contacts ≈ $0.002 a month | **No limit needed for cost** |
| Searches (AI search, MCP, Storage) | ~$0.00001–0.00003 each | **No limit needed for cost**; rate limits stop abuse |
| Agent runs | ~$0.0001 a run; AI tokens are on the customer's own key | No limit needed for cost |

### Measured on production

**2026-11-18**, the main organization (b6b21012…) after Stalwart was removed:

| Measure | Value | Per email |
|---|---|---|
| Search passages (vectors) | 216,344 | **2.63** |
| Organization R2 bucket (raw messages plus attachment copies) | 13.8 GB | ~145 KB |
| MailboxStore Durable Objects | 181 MB | ~2.2 KB |
| Mail volume | ~1,600 received and ~100 sent a month | – |
| Variable cost, whole org | **~$2.40 a month**; Vectorize is ~75% of it | – |

Per mailbox a month on that day: asif@hireninja.com ~$1.79 (of which search $1.50), mohammad@asif.pk ~$0.94,
asif@xstate.com ~$0.11.

**2026-11-16**, the same organization still on Stalwart: 82,019 emails, 215,925 vectors (2.44 per email), mail blobs
5.54 GB plus attachment copies ~5 GB, D1 47.7 MB (about 0.5 MB per 1,000 emails, mostly `search_docs` and `files`).

### Unit costs

| Cost | Rate | Per 1,000 emails |
|---|---|---|
| **Keeping mail searchable**, every month | Vectorize bills every stored vector as queried dimensions, at $0.01 per million, plus storage at $0.05 per 100 million dimensions. 2,630 vectors × 1,024 dimensions is 2.7M dimensions | **$0.028 a month** |
| Indexing, once | bge-m3 at $0.012 per million tokens. About 450 tokens per 1,800-character passage | $0.013 once |
| Storing mail and attachments in R2 | $0.015 per GB-month, egress free. ~145 KB per email, because attachments are kept both inside the raw message and as a separate `files` copy | $0.002 a month |
| Receiving | SES: $0.10 per 1,000 messages plus $0.09 per 1,000 incoming 256 KB chunks | ~$0.20 |
| Sending | SES: ~$0.10–0.16 per 1,000 messages (the bill shows "Essentials" at ~$0.16), plus $0.12 per GB of attachments | ~$0.15 |
| Mailbox index | Durable Object SQLite storage at $0.20 per GB-month beyond the account's 5 GB. ~2.2 KB per email | ~$0.0004 a month |
| Workers, Queues, D1 and Durable Objects per message | Queue operations at $0.40 per million, D1 and DO rows written at $1 per million | about $0.013 per 1,000 messages handled |
| One MCP search / one-file search / attachment text | earlier measurement | $0.00003 / $0.00001 / $0.000002 |
| One agent run (the AI tokens are the customer's) | Workflows: $0.30 per million requests, $0.80 per 100,000 steps (step billing hasn't started yet). A run of about 10 steps costs about $0.0001 | – |

Keeping mail searchable costs about **14 times as much as storing it**. That is why the plans limit search
history and leave storage generous.

### Monthly cost per mailbox

| Profile | Light (Free, 90-day window) | Typical (Pro) | Heavy (Pro at its cap) |
|---|---|---|---|
| Emails kept searchable | about 3,000 | 15,000 | 52,000 |
| Search vectors | $0.08 | $0.42 | $1.46 |
| R2: mail and attachments | $0.01 | $0.03 | $0.11 |
| R2: Storage files | $0.00 | $0.15 (10 GB) | $0.45 (30 GB full) |
| SES received: 300 / 1,000 / 2,500 | $0.06 | $0.20 | $0.50 |
| SES sent: 300 / 800 / 2,500 | $0.03 | $0.10 | $0.32 |
| Mailbox index | $0.00 | $0.01 | $0.02 |
| Workers, Queues, D1 | $0.01 | $0.02 | $0.04 |
| **Total** | **about $0.19** | **about $0.93** | **about $2.90** |

The worst case for a free person at every cap is about $1.00 a month: 5 GB of mail, 100 outside recipients every
day, and 200 MCP searches every day. A typical free organization of 3 light users costs about $0.57 a month.

None of this includes website analytics, which is per organization, not per mailbox (§3a).

### 3a. Website analytics events

Every event that `/v1/collect` accepts (a pageview, a custom event, an `$email_*` event) is written to the
organization's AudienceStore Durable Object. Counted from `apps/api/src/audience/store.ts` on 2026-11-19, one
pageview writes about **15 rows** once indexes are counted:

- the `events` row and its 5 indexes;
- the `event_names` counter;
- the visit in `sessions` and the indexes its update touches;
- the person's `last_seen_at` in `people` and its indexes.

| Cost | Rate | Per million events |
|---|---|---|
| Durable Object rows written | $1 per million rows, ~15 rows an event | ~$15.00 |
| Worker request | $0.30 per million | $0.30 |
| Durable Object request | $0.15 per million | $0.15 |
| Storage | Events kept 90 days, visits 180 days; ~0.5 KB per event with indexes at $0.20 per GB-month | ~$0.05 a month per million kept |
| **Total** | | **~$15.50** |

The 15 rows are counted from the code, not measured on production. Check it against the Durable Objects
rows-written metric once real traffic arrives.

| Site | Events a month | Cost a month |
|---|---|---|
| Small business site | 10,000 | $0.16 |
| Busy marketing site | 100,000 | $1.55 |
| Busy site with product events | 1,000,000 | $15.50 |

A site with 100,000 pageviews a month costs more than a heavy mailbox's search. Unlike mail, the traffic comes
from the customer's visitors, not their people, so it doesn't grow with seats. The included 50M rows written on
Workers Paid covers only about 3M events across all organizations together.

**Proposed limits (not decided):**

| | Free | Pro | Team |
|---|---|---|---|
| Analytics events a month | 10,000 per org | 25,000 per person, pooled | 100,000 per person, pooled |
| Cost at the limit | $0.16 per org | $0.39 per person | $1.55 per person |
| Extra events | – | $5 per 100,000 a month (cost $1.55 today, ~$0.65 after the fix below) | same |

Over the limit, the usual 10% grace applies, then `/v1/collect` stops recording events until the month resets.
Contacts, identify calls and already-recorded data are untouched. Cutting the rows per event (§6, item 7) to about
6 would bring the cost down to about $6.50 per million.

---

## 4. Payment fees

| Provider | Fee | On a 5-person Pro org, monthly ($30) | On the same org, yearly ($300) |
|---|---|---|---|
| **Paddle** (merchant of record: handles VAT and sales tax worldwide) | 5% + $0.50 | $2.00, or $0.40 per person | $15.50, or $0.26 per person a month |
| Stripe + Billing (you handle tax yourself, or add Stripe Tax) | 2.9% + $0.30 + 0.7%, and +1.5% on international cards | $1.38 to $1.83 | $11.10 to $15.60 |

**Recommendation: Paddle.** HireNinja LLC sells worldwide to small businesses. A merchant of record takes on
VAT and GST registration, filing and invoices in every country. The extra 1–2% costs less than doing that work
yourself. The margins below use Paddle.

---

## 5. Margin per plan

Margin = (price − payment fee − cost to run) ÷ price.

| | Price | Fee | Cost | Margin |
|---|---|---|---|---|
| Pro, monthly, typical person | $6.00 | $0.40 | $0.93 | **$4.67 (78%)** |
| Pro, monthly, heavy person | $6.00 | $0.40 | $2.90 | $2.70 (45%) |
| Pro, yearly, typical person | $5.00 | $0.26 | $0.93 | $3.81 (76%) |
| Pro, yearly, heavy person | $5.00 | $0.26 | $2.90 | $1.84 (37%) |
| Team, monthly, typical person (30 GB used) | $12.00 | $0.65 | $1.23 | $10.12 (84%) |
| Team, monthly, a person at every cap (200,000 emails, 200 GB) | $12.00 | $0.65 | about $9.50 | about $1.85 (15%) |
| Extra storage, 100 GB | $5.00 | $0.25 | $1.50 | $3.25 (65%) |
| Extra analytics events, 100,000 (proposed, §3a) | $5.00 | $0.25 | $1.55 | $3.20 (64%) |

Costs refreshed 2026-11-19 (§3): no deepo share, SES receiving added, 2.63 vectors per email. Margins exclude
website analytics, which is per organization and needs its own limit (§3a). Without one, a Pro organization of
one person with a 100,000-pageview site would cost $0.93 + $1.55 and fall to a 52% margin; a typical free
organization with the same site would cost xstate about $2.12 a month instead of $0.57.

**How free users are paid for.** One typical Pro person contributes about $4.67 a month. That covers about 24
light free people, or about 8 typical free organizations. Fixed costs ($5) are covered by about one Pro person.

**Agents and connected apps** barely affect cost. Their token costs are the customer's. The run limits and
daily call limits exist to stop runaway loops, not to cover a bill. A single connected app searching at today's
limit of 120 calls a minute would cost xstate about $170 a month, and the daily limits cap it at about $1.80
a month per person on Pro.

---

## 6. Cutting costs before launch (engineering follow-ups, not part of pricing)

1. **Index less of each email.** 2.63 passages per email (2026-11-18) is high for business mail. Each reply most likely
   carries the whole quoted thread below it, so the same text is indexed many times. Stripping quoted replies and
   signatures before splitting could cut the vector bill by around 40–50%, which is the plan's largest variable
   cost. Measure it on the migrated org first.
2. **Attachments are stored twice.** They are kept once inside the raw message (`<mailboxId>/raw/<emailId>.eml`)
   and once as a `files` copy, both in the org's R2 bucket (~145 KB per email in total). At $0.015 per GB this is
   cheap, but it doubles what a storage cap has to count. The cap should count what the customer sees, which is mail once plus their Storage files.
3. **D1 will hit its 10 GB limit.** `search_docs` and `files` take about 8 MB per heavy mailbox. At that rate
   the limit arrives at about 1,200 heavy mailboxes. Plan a move (for example per-org Durable Objects) well
   before then.
4. **The SES account quota is shared by every customer.** It is 50,000 recipients a day, 14 a second. 25 Pro
   orgs sending at their limit of 2,000 a day would fill it. Ask AWS for a higher quota as paid organizations
   grow.
5. **Cleared:** deepo no longer runs anything for xstate since Stalwart stopped on 2026-11-18. Stalwart's leftover
   data (Postgres DB, `xstate-mail-blobs`) is deleted in phase 5c after ~2026-12-18.
6. **Observability pricing changes on 2026-12-01.** Workers Logs moves to per-GB billing: 50 GB of ingest
   included, then $0.25 per GB. Check the log volume of the `mcp call` and migration logs.
7. **Write fewer rows per analytics event.** One pageview writes about 15 Durable Object rows (§3a), almost all of
   it the cost of an event. Options: drop `events` indexes that no query needs, update `people.last_seen_at` at most
   once per visit instead of on every event, and keep `event_names` counts in memory and flush them on the daily
   alarm. About 6 rows an event would cut the cost from ~$15.50 to ~$6.50 per million. Measure rows written per
   event on production first.

---

## 7. What enforcing the plans needs

**Built 2026-11-16 (billing, not yet limits), uncommitted:**
- Migration `0031_billing.sql`: `organizations.plan`, interval, Paddle customer and subscription, status, billed
  seats, period end, scheduled change, and `billing_event_at` so out-of-order webhooks can't regress the plan.
- `apps/api/src/billing/`: `plans.ts` (prices, PADDLE_PRICES mapping, status → plan), `paddle.ts` (REST calls with
  fetch, webhook HMAC check), `service.ts` (billing view, confirm checkout, change plan, portal links, seat sync),
  `webhook.ts` (`POST /webhooks/paddle`). Operations `billing_get`, `billing_confirm_checkout`,
  `billing_change_plan`, `billing_portal` (off MCP; owners and admins only for changes).
- Seats follow personal mailboxes: synced after a person's mailbox is created or deleted and hourly (imports are
  caught by the hourly check). Quantity changes are prorated immediately.
- `scripts/paddle-catalog.mjs` creates the Pro and Team products and monthly/yearly prices (idempotent) and prints
  PADDLE_PRICES. The storage add-on isn't in the catalog yet.
- App: Settings → Billing (`apps/app/src/settings/Billing.tsx`), Paddle.js overlay checkout, `?_ptxn=` links.
- Marketing pricing table, Terms §4 (Paddle as reseller), Privacy (Paddle replaces Stripe) and Security updated.
- Tested locally with signed test webhooks (plan applied, bad signature 401, stale event ignored, past due keeps
  the plan, cancelled → free). A real sandbox checkout still needs the sandbox keys.

**Paddle accounts set up 2026-11-16:**
- Sandbox ("HireNinja Staging"): API key "xstate local dev" (expires 2027-02-14) and client token in
  `apps/api/.dev.vars`; catalog created; default payment link `https://localhost/`. Tested end to end in the local
  app: checkout with the test card → Pro, switch to Team, portal links. No sandbox webhook destination (localhost
  isn't reachable); checkout is confirmed by the app instead.
- Live ("HireNinja LLC"): API key "xstate production API" (expires **2027-11-16**, renew before then) and webhook
  secret stored as Worker secrets; catalog created; client token and live price ids in `wrangler.jsonc`; webhook
  destination `https://api.xstate.com/webhooks/paddle` (subscription events, platform + simulation).
- Deployed 2026-11-16 with a 14-day refund policy (`/docs/refunds`, linked from Terms §4 and the footer), which
  Paddle's domain review requires. `xstate.com` and `go.xstate.com` submitted for Website approval the same day
  (In review). Once approved: set the live default payment link to `https://go.xstate.com/app/`. Live checkout
  fails until then.

**Not built yet:** every usage limit below (people, domains, storage, search window, MCP and agent quotas, sending
by plan) and the 10% grace. Until then, plans change billing and the plan name only.


- **D1:** add `organizations.plan`, `plan_seats`, `billing_customer_id` and `billing_status`, plus a usage
  table with monthly counters for agent runs and daily counters for MCP calls.
- **Billing:** Paddle checkout and the customer portal, and a `/webhooks/paddle` route that sets the plan. A
  failed payment gets a 14-day grace period, then the org drops to Free limits. No mail is deleted. AI search
  goes back to the 90-day window and agents pause.
- **Over a limit (decided): 10% grace, then stop.** Each usage limit lets an organization go 10% past it.
  Once it reaches 110%, xstate stops handling more of that kind of traffic. It never deletes anything, and the
  org gets a notice at 100% and again at 110%. Concretely:
  - **Storage at 110%:** new incoming mail is refused with a temporary "mailbox full" error (452), not a
    permanent bounce. Senders' servers keep retrying for several days, so the mail arrives once space is freed
    or the plan is upgraded. Storage uploads and saves are refused too.
  - **Searchable mail at 110%:** new mail stops being indexed. Search still works over what is already indexed.
  - **MCP calls a day and agent runs a month at 110%:** further calls and runs are refused until the day or
    month resets.
  - **Sending limits get no grace (my call).** They exist to stop abuse and to protect SES's reputation for
    every customer, so they stay hard at 100%, as they are today.
- **Limits, checked where each action already happens:**
  - People and domains: when a mailbox or domain is created.
  - Storage: the sum of R2 bytes for raw messages (checked when SES mail is received) and Storage uploads.
  - Analytics events a month: `/v1/collect` (`audience/collect.ts`), counted in the AudienceStore.
  - Search window: `search/jobs.ts` skips emails older than the window, and the hourly sweep removes vectors
    that have aged out of it.
  - Search history cap: count indexed emails per org.
  - MCP calls a day: `mcp/server.ts`.
  - Agent runs a month: `agents/run.ts`.
  - Sending: make `LIMITS` in `mailserver/sending-rules.ts` depend on the plan.
- **App:** a Settings → Plan & billing page, and usage bars for storage, searchable mail and agent runs.
- **Marketing and terms:**
  - Replace the placeholder pricing table on the marketing page.
  - Terms §4 already allows a free email plan with paid features. Add the free-plan limits to §6.
  - Update `security.md` if Paddle receives any customer data beyond billing.

---

## 8. Decisions (2026-11-16)

1. **Free plan:** as proposed. Up to 5 people, 1 domain, 5 GB each, AI search over the last 90 days, connected
   apps allowed, no agents.
2. **Pro:** $6 a month per person, or $5 billed yearly.
3. **Launch all three plans now**, including Team at $12 a month or $10 billed yearly.
4. **Shared mailboxes have no seat charge.** Their mail counts toward the pooled storage and search caps.
5. **Over a limit:** a 10% grace, then xstate stops handling more traffic of that kind (§7). Nothing is deleted.
6. **Payments:** Paddle (merchant of record) for now.
7. **Dedicated server for xstate:** postponed.

---

## 8a. New direction: pricing by monthly active audience (2026-11-19, in progress)

On 2026-11-19 the user proposed pricing xstate like Loops (https://loops.so/pricing): a free tier up to a number
of contacts, then $49 a month and up by contacts. This section records what is decided and what is still open.
Until it is finished, §1 and §8 describe the plans that are built in Paddle.

### Decided (user, 2026-11-19)

**The price metric is the monthly active audience:** the number of distinct people an organization was in touch
with in a calendar month. A person counts once a month, however many times they appear. A person counts when:

1. **anyone in the organization emailed them, or received an email from them** that month: mailboxes, shared
   mailboxes, agents, the email API and campaigns alike; or
2. **they visited one of the organization's tracked websites as an identified visitor** that month (a visitor
   with an email address: signed up, filled a form, was identified with `identify()`, or is already a contact).

**Anonymous website visitors are not counted.** Analytics on a site stays free however busy the site is, so the
snippet is never a reason to pay. Their cost (about $15.50 per million events, §3a) is covered by an event limit,
not by the price metric.

Everyone counted is also added to Contacts automatically, which is the product side of the same rule.

**What counts (user, 2026-11-19, second round).** Only mail in **Junk** is left out. Everything else counts:
the organization's own addresses and domains (teammates included), Cc and Bcc recipients, newsletters and
notification senders, and system senders. A 10-person team therefore adds at least its own 10 people to its
audience. Bounce and system senders (`mailer-daemon@`, SES notifications) now count too; the user may want to
leave those out later, since nobody is reached.

### Tiers

Decided by the user on 2026-11-19 unless marked proposed or open:

| | Free | Growth | Above Growth |
|---|---|---|---|
| Active audience a month | 1,000 | 5,000 | +100 at a time (user, 2026-11-19) |
| Price | $0 | $49 a month | **+$1 per extra 100** a month (user, 2026-11-19) |
| Domains | 3 | **unlimited** | unlimited |
| Agents (on the customer's own AI key) | 1 (reverses the 2026-11-16 "no agents on Free" decision; cost ~$0.0001 a run) | **unlimited** | unlimited |
| Mailboxes (personal and shared together) | **5** | **unlimited** | unlimited |
| Emails sent | **4,000 a month**, every mailbox, agent and API call together | **unlimited** (hourly and daily abuse limits stay, §7) | unlimited |
| Website analytics events | **proposed:** 10,000 a month | **proposed:** 100 per active contact a month | same |
| AI search over mail | **all mail, no window for now** (user, 2026-11-19; bounded by the 5 GB storage limit) | **up to 100 searchable emails per active audience** (500,000 at 5,000); decided 2026-11-19, internal only, not on the pricing page | grows with the tier |
| Storage (mail + files), per organization | **5 GB** (user, 2026-11-19) | **50 GB** (user, 2026-11-19; was 35 GB) | +1 GB per extra 100 active audience (user); more at $5 per 100 GB |

**Why searchable mail still needs a limit on Growth.** The active audience tracks how many people an
org deals with, not how much mail its mailboxes hold. On 2026-11-18 the main organization had 6 mailboxes, cost
about $2.40 a month, sent about 100 emails and received about 1,600; it counted 322 active people over the
last 30 days (measured 2026-11-19, below) and would stay on Free.
Mailbox cost comes from mail kept searchable (§3), so Free keeps the 5-mailbox limit. The user chose (2026-11-19) not to limit AI search on Free for now: the 5 GB
storage limit bounds it, since 5 GB holds about 35,000 emails (~145 KB each), about $1 a month of search per
free organization at most. Revisit if free orgs with heavy mail add up.

With unlimited mailboxes on Growth, the audience is the only thing that grows with the team. Counting teammates and
Cc recipients helps: on the measured org each personal mailbox brought about 80 active people, so a 100-person
team would land around 8,000 active and pay about $79. Its mailboxes would cost about $93 a month at the typical
$0.93 each (§3), most of it keeping mail searchable. **Decided (user, 2026-11-19):** cap searchable mail on Growth at 100 emails per
active audience (500,000 emails at 5,000, about $14 a month of Vectorize), growing with the tier. Older mail stays
stored and listed but leaves AI search, as on Free. **The cap is internal: the pricing page doesn't show it.**
When an org reaches it, the oldest mail drops out of AI search first; the app and the help docs should say so
where search results are shown, so a missing old email doesn't look like a bug.

**Unlimited emails on Growth** means no monthly cap. The hourly and daily limits per mailbox and per org
(`reserveSend` in `mailserver/sending-rules.ts`) stay, because they protect SES's sending reputation for every
customer (§8, item 5). Raise them for paid orgs as the shared SES quota (50,000 recipients a day, §6, item 4) grows.
SES costs ~$0.16 per 1,000, so 50,000 emails a month is ~$8.

**Free's 4,000 emails a month** counts recipients, because SES bills per recipient: one email to 3 people is 3.
(Assumption; the user said "emails".)

**Storage (user, 2026-11-19): 5 GB per organization on Free, 50 GB per organization on Growth at 5,000 people.** The pricing
page shows only the current total as the slider moves, not the per-100 rule.

- **What counts:** what the customer can see: each email once (its raw message, attachments included), Storage
  files with their kept versions, and trash. The internal `files` copies of mail attachments don't count, or every
  attachment would count twice (§6, item 2).
- **Over the limit:** the decided 10% grace, then incoming mail is refused with a temporary 452 "mailbox full",
  so senders retry for days, and uploads are refused (§7). Nothing is deleted.
- **Measured 2026-11-19 on the main organization:** Storage files 1.9 GB (611 files), plus about 7 GB of mail
  (13.8 GB in the org's R2 bucket on 2026-11-18, minus about 5 GB of attachment copies), so **about 9 GB**.
  This org would already be at 180% of the Free limit and refusing mail. A Google Workspace import of a few years
  of mail will usually pass 5 GB on its own: decide whether an import may go over the limit, or stops at it with
  a clear message.
- **Cost:** R2 at $0.015 per GB-month, so 5 GB is $0.08 and 50 GB is $0.75 a month. Storage is not where the cost
  is (§3); searchable mail is.
- **Decided 2026-11-19: Growth starts at 50 GB** (earlier recommendation was 100 GB; 35 GB was the first proposal).

**Storage that grows with the audience (decided by the user, 2026-11-19): 1 GB per extra 100 active audience.**
Free has 5 GB and Growth 50 GB at 5,000 (raised from 35 GB by the user, 2026-11-19); above that, every extra 100 active audience adds 1 GB. The price rises in
the same steps: **$1 per extra 100 active audience** ($10 per 1,000), also decided by the user on 2026-11-19:

| Active audience a month | Price | Storage per organization | R2 cost a month |
|---|---|---|---|
| 1,000 (Free) | $0 | 5 GB | $0.08 |
| 5,000 (Growth) | $49 | 50 GB | $0.75 |
| Each extra 100 | +$1 | **+1 GB** | +$0.015 |
| 10,000 | $99 | 100 GB | $1.50 |
| 25,000 | $249 | 250 GB | $3.75 |
| 1,000,000 (top of Growth) | $9,999 | 10,000 GB | ~$150 |
| Over 1,000,000 | **Custom** (user, 2026-11-19) | set per customer | – |
| More storage at any tier | $5 per 100 GB | – | $1.50 |

The extra 1 GB per 100 costs $0.015 against $1 of price, so it barely moves the margin.

The limit of this rule: mail piles up over the years while an org's audience stays about the same. The main
organization has about 28 MB of storage per active person (9 GB over 322), while Growth gives 10 MB per person
(50 GB over 5,000). A steady org will outgrow its storage without moving up a tier, so the $5 per 100 GB add-on
has to be available at every paid tier, and Billing should show storage and audience side by side.

**Billing in tiers, not by metering.** Paddle bills subscriptions in advance and has no built-in metered billing.
The org picks a tier. The usual 10% grace applies (§8, item 5), and an org above 110% for two months in a row moves
up a tier, with notice at 100% and 110%. Settings → Billing shows the live count, split into emailed and
website people, so the bill is never a surprise.

### Cost check (worst case, every allowance used)

| | Price | Paddle fee | Audience cost (sends + events) | Mailbox cost | Margin |
|---|---|---|---|---|---|
| Free, 1,000 active, 5 light mailboxes | $0 | – | ~$0.64 (4,000 sends) + $0.16 (10,000 events) | ~$0.95 | costs ~$1.75 |
| Growth, 5,000 active, 10 typical mailboxes, 50,000 sends | $49 | $2.95 | ~$8.00 + $7.75 | ~$9.30 | **~$21 (43%)** |
| Growth, 5,000 active, 33 typical mailboxes | $49 | $2.95 | ~$8.00 + $7.75 | ~$30.70 | **break-even** |
| Each extra 1,000 active (10 steps of $1) | $10 | $0.50 | ~$1.60 + $1.55 + $0.15 storage | – | ~$6.20 (62%) |

Typical use is far below these allowances, so real margins will be higher. The 33-mailbox row is why searchable
mail needs a cap on Growth: without one, each extra mailbox costs about $0.93 a month and brings in nothing until
the audience grows.

**Custom plan (user, 2026-11-19): for organizations reaching more than 1,000,000 people a month.** Growth's
$1-per-100 steps run up to 1,000,000 ($9,999 a month); above that the price is agreed per customer. Shown on the
design as: everything in Growth, volume pricing, storage and sending limits set per customer, migration help,
priority support and yearly invoice billing (the last three are proposed wording, not built). Before selling one:

- **Analytics won't hold that size today.** One AudienceStore Durable Object per org stores at most 10 GB, about
  20 million events kept 90 days, and takes a few hundred events a second (§3a). A 1M+ audience with a busy site
  needs raw events moved to a store built for volume (for example Workers Analytics Engine) first.
- **Sending needs its own SES setup.** The shared SES account quota is 50,000 recipients a day (§6, item 4).
- **Storage at $1 per 100 is generous at the top:** 1M people on Growth gets ~11 TB, ~$165 a month of R2 against
  $9,999; fine on margin, but a Custom deal should set its own storage.

### Measured on production (2026-11-19)

The main organization, 2026-10-20 to 2026-11-19, read through the MCP `email_list_messages` tool. Junk excluded,
trash included, the org's own domains and system senders excluded. Distinct addresses, counted once per org:

| Mailbox | Conversations (received / sent) | Inbound senders (person-like / automated) | Sent to | Active audience |
|---|---|---|---|---|
| asif@hireninja.com | 517 / 7 | 164 (88 / 76) | 3 | 166 |
| asif@xstate.com | 275 / 57 | 90 (38 / 52) | 40 | 124 |
| mohammad@asif.pk | 243 / 7 | 50 (26 / 24) | 1 | 50 |
| asif@upfold.me | 16 / 1 | 8 (5 / 3) | 0 | 8 |
| hello@xstate.com (shared) | 2 / 0 | 1 (0 / 1) | 0 | 1 |
| **Organization, deduplicated** | | | | **322** |

What it shows:

- **Received mail sets the count, not sent mail.** About 95% of the active audience are people who wrote to the
  org; about half of those are automated senders (newsletters, notifications, services).
- **About 80 active people per personal mailbox** in this org (322 over 4). At that rate 1,000 free covers about
  12 people, so on Free the 5-person limit is what really applies, not the audience limit.
- **This org pays nothing under the new model**, yet costs about $2.40 a month. That confirms the people limit and
  the 90-day search window must stay on Free.

Limits of this measurement:

- One organization, run by a founder who sends little. A sales or support team sends far more and would count higher.
- It's a lower bound. The listing gives one row per conversation (its newest message), so earlier senders in
  multi-message threads are missed. Only about 3% of conversations had more than one message, so the gap is small.
- Three shared mailboxes (hello@99events.com, team@99events.com, no-reply@xstate.com) were not readable through
  this MCP connection and are not counted. They are low-volume pilot and system mailboxes.
- Cc wasn't available on sent rows, so Cc recipients are not counted.
- The person-like/automated split is a rough guess from the address, and probably counts some automated senders
  as people.
- **Transactional senders will count high.** A SaaS that sends sign-up and receipt mail from a no-reply mailbox
  counts every user it emails. Decide whether API sends from a no-reply mailbox count the same way.

### To do before the tiers are final

1. **Measure a second, busier organization** once a real customer (or a sales or support mailbox) has a month of
   mail, to check the ~80-per-person figure.
2. Decide the open points in the tables above.
3. Decide what happens to the built per-person plans (§1, §7): replaced, or kept for mail-only customers.
4. Then update §1, §7 and §8, the Paddle catalog (`scripts/paddle-catalog.mjs`), the marketing pricing page and
   the Terms.

---

## 9. Sources (read 2026-11-16)

- Cloudflare Workers, Queues, Workflows, KV, D1, Durable Objects: https://developers.cloudflare.com/workers/platform/pricing/
- Observability from 2026-12-01: https://developers.cloudflare.com/observability/pricing/
- R2: https://developers.cloudflare.com/r2/pricing/ (Standard $0.015 per GB-month, Infrequent Access $0.01, egress free)
- Vectorize: https://developers.cloudflare.com/vectorize/platform/pricing/
- Workers AI and bge-m3 ($0.012 per million tokens): https://developers.cloudflare.com/workers-ai/platform/pricing/; toMarkdown is free for most formats
- Amazon SES: https://aws.amazon.com/ses/pricing/ (the old 12-month free tier is gone, replaced by AWS credits)
- EC2 t3.medium, Ohio, $0.0416 an hour (AWS pricing data file); EBS gp3 $0.08: https://aws.amazon.com/ebs/pricing/; IPv4: https://aws.amazon.com/vpc/pricing/
- Stripe: https://stripe.com/pricing · Paddle: https://www.paddle.com/pricing
- Competitors, per person a month (monthly / yearly):
  - Google Workspace Business Starter $8.40 / $7, 30 GB: https://workspace.google.com/pricing
  - Microsoft 365 Business Basic $8.40 / $7 (raised 2026-07-01): from microsoft.com search results; the page timed out
  - Zoho Mail Lite $1 / $1.25 yearly; Forever Free is 5 users, 5 GB and no IMAP: https://www.zoho.com/mail/zohomail-pricing.html
  - Proton Mail Essentials $6.99 yearly: https://proton.me/business/mail/pricing
  - Fastmail Standard $6 / $5, 60 GB: https://www.fastmail.com/pricing/
- Production usage: D1 queries and `wrangler r2 bucket info xstate-mail-blobs` on 2026-11-16; deepo `df`;
  vectors, org R2 bucket, MailboxStore size, mail volume and the SES bill on 2026-11-18
- Rows per analytics event: counted from `apps/api/src/audience/store.ts` on 2026-11-19 (not measured)
- Loops pricing: https://loops.so/pricing (read 2026-11-19): Free up to 1,000 subscribed contacts and 4,000 sends a month; $49 for 5,000 contacts, unlimited sends; no seat fees
