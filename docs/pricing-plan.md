# Plan: xstate pricing

Status: **built 2026-11-19.** Plans are priced by the monthly active audience: Free, Growth and Custom (§1, §8a).
Billing runs on Stripe and the plan limits are enforced (§7; build notes and status in
`docs/billing-limits-plan.md`). **There is no charge per person, seat or mailbox.** The code is
`apps/api/src/billing/plans.ts` (plans, prices, limits) and `apps/api/src/limits/` (the checks).
Costs refreshed 2026-11-19 after Stalwart was removed (§2–§3). Analytics event limits are proposed, not built (§3a).
The dedicated-server question is postponed.

The margins come from what xstate pays to run (§2–§4). Usage figures are measured on production where possible.

---

## 1. The plans

| | **Free** | **Growth** | **Custom** |
|---|---|---|---|
| Active audience a month (§8a) | 1,000 | 5,000, then +100 at a time up to 1,000,000 | over 1,000,000 |
| Price | $0 | **$49 a month**, plus **$1 per extra 100** | agreed per customer |
| Mailboxes (personal and shared together) | 5 | unlimited | set per customer |
| Domains | 3 | unlimited | set per customer |
| Agents (on the customer's own AI key) | 1 | unlimited | set per customer |
| Emails sent | 4,000 a month, every recipient counted | unlimited; the hourly and daily abuse limits stay | set per customer |
| Storage (mail plus files), per organization | 5 GB | 50 GB, +1 GB per extra 100 | set per customer |
| AI search over mail | all mail (bounded by the 5 GB) | up to 100 searchable emails per person of its size; internal, not on the pricing page | set per customer |
| Website analytics events | proposed, not built (§3a) | proposed, not built | – |

- **No charge per person, seat or mailbox.** Teammates and shared mailboxes cost nothing extra. On Free the
  5-mailbox limit covers personal and shared mailboxes together; inviting someone without a mailbox doesn't count.
- **Growth** is billed monthly in advance as two Stripe items: "Growth" ($49 × 1, 5,000 people) and "Extra 100
  people" ($1 × the extra hundreds). Changing the size is prorated at once.
- **Custom** is sold by hand: an admin sets `organizations.plan = 'custom'` and `limits_override` in D1. Limits
  left unset are unlimited.
- **Over a limit:** counted limits allow 10% over, rounded down, so 5 mailboxes, 3 domains and 1 agent stop at
  the limit itself. Storage stops over 110%. Emails a month stop at 100%, like every sending cap. Mail always keeps
  arriving and nothing is deleted.
- **Active audience over the limit:** a Free organization over 110% is paused for the rest of the month (email
  API sends, agent runs and new identified website visitors) until the month ends or it upgrades. Growth at or
  over its size gets a weekly email to owners and admins; nothing stops.

---

## 2. What xstate pays: fixed costs

Refreshed 2026-11-19. Stalwart stopped on 2026-11-18, so deepo is no longer an xstate cost.

| Item | Monthly | Notes |
|---|---|---|
| Cloudflare Workers Paid | $5.00 | Includes 10M requests, 30M CPU-ms, 1M queue operations, D1/DO/KV allowances (Durable Objects: 50M SQLite rows written and 5 GB stored), 50M queried and 10M stored Vectorize dimensions, and Workflows allowances |
| Amazon SES base | $0 | Pay as you go, no monthly fee, for both sending and receiving |
| Stripe | $0 | Fees per payment only (§4) |
| **Total** | **about $5** | Covered by one Growth organization (§5) |

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

| Profile | Light | Typical | Heavy |
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

A typical free organization of 3 light users costs about $0.57 a month.

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
from the customer's visitors, not their people, so it doesn't grow with the team. The included 50M rows written on
Workers Paid covers only about 3M events across all organizations together.

**Proposed limits (not decided, not built):**

| | Free | Growth |
|---|---|---|
| Analytics events a month | 10,000 per organization | 100 per person of its size (500,000 at 5,000) |
| Cost at the limit | $0.16 | $7.75 at 5,000 |

Over the limit, the usual 10% grace applies, then `/v1/collect` stops recording events until the month resets.
Contacts, identify calls and already-recorded data are untouched. Cutting the rows per event (§6, item 7) to about
6 would bring the cost down to about $6.50 per million.

---

## 4. Payment fees

Stripe: Checkout, Billing and the Customer Portal. There is no merchant of record: HireNinja LLC sells, Stripe
processes the payment, and taxes are added where the law requires (Terms §4).

| Fee | On Growth at 5,000 ($49) | On each extra $1 step |
|---|---|---|
| 2.9% + $0.30, plus 0.7% for Stripe Billing | $2.06 | $0.04 |
| Plus 1.5% on international cards | $2.80 | $0.05 |

---

## 5. Margin

Margin = (price − payment fee − cost to run) ÷ price. Worst case, every allowance used; typical use is far below
these allowances, so real margins are higher.

| | Price | Stripe fee | Audience cost (sends + events) | Mailbox cost | Margin |
|---|---|---|---|---|---|
| Free, 1,000 active, 5 light mailboxes | $0 | – | ~$0.64 (4,000 sends) + $0.16 (10,000 events) | ~$0.95 | costs ~$1.75 |
| Growth, 5,000 active, 10 typical mailboxes, 50,000 sends | $49 | $2.06–2.80 | ~$8.00 + $7.75 | ~$9.30 | **~$21–22 (43–45%)** |
| Growth, 5,000 active, 33 typical mailboxes | $49 | $2.06–2.80 | ~$8.00 + $7.75 | ~$30.70 | **break-even** |
| Each extra 1,000 active (10 steps of $1) | $10 | $0.36–0.51 | ~$1.60 + $1.55 + $0.15 storage | – | ~$6.20 (62%) |

The 33-mailbox row is why searchable mail is capped on Growth: without the cap, each extra mailbox costs about
$0.93 a month and brings in nothing until the audience grows.

**How free organizations are paid for.** The 10-mailbox Growth row leaves about $21 a month, which covers about
12 free organizations at their worst case or about 37 typical ones ($0.57). Fixed costs ($5) are covered by one
Growth organization.

**Agents and connected apps** barely affect cost. Their AI tokens are on the customer's own key. A single
connected app searching at today's rate limit of 120 calls a minute would cost xstate about $170 a month, so the
rate limit is what protects against it, not the price.

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
4. **The SES account quota is shared by every customer.** It is 50,000 recipients a day, 14 a second. 25
   organizations sending at today's limit of 2,000 a day would fill it. Ask AWS for a higher quota as paid organizations
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

## 7. How the plans are enforced

Built; build notes, what was tested and deploy status are in `docs/billing-limits-plan.md`.

- **Billing:** Stripe Checkout, the Customer Portal and the webhook (`apps/api/src/billing/stripe.ts`,
  `billing/stripe-events.ts`). `scripts/billing-catalog.mjs` creates the prices `xstate_growth_base` ($49) and
  `xstate_growth_extra_100` ($1).
- **Limits** (`apps/api/src/limits/index.ts`), checked where each action already happens and refused with 402
  `plan_limit` (429 `send_limit_reached` for sending):
  - mailboxes: `createMailbox` (personal and shared), adding a member with a mailbox, and the Google import;
  - domains: `addDomain`; agents: create and duplicate;
  - storage: Storage uploads, saves, version restores and saved attachments;
  - emails a month: `reserveSend` (system mail is exempt).
- **Hourly** (`limits/hourly.ts`): notices at 100% and 110%, the Free audience pause, Growth's weekly email.
- **Searchable mail on Growth:** `limits/search-cap.ts` moves the emails indexed longest ago out of AI search.
- **App:** Settings → Billing shows usage bars and a banner while paused.
- **Not built:** analytics event limits (§3a), and moving Growth up a size automatically.

---

## 8. Decisions

1. **Price by monthly active audience** (user, 2026-11-19), with the tiers in §8a. This replaced the per-person
   plans decided on 2026-11-16; there is no charge per person, seat or mailbox.
2. **Payments on Stripe** (user, 2026-11-19), replacing Paddle (`docs/billing-limits-plan.md`).
3. **Over a limit:** a 10% grace, then xstate stops handling more of that kind (§1). Sending caps stay hard at
   100%. Nothing is deleted.
4. **Dedicated server for xstate:** postponed.

---

## 8a. Pricing by monthly active audience (decided 2026-11-19)

Priced like Loops (https://loops.so/pricing): a free tier up to a number of people, then $49 a month and up by
people.

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
| Emails sent | **4,000 a month**, every mailbox, agent and API call together | **unlimited** (hourly and daily abuse limits stay, §1) | unlimited |
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
customer (§1). Raise them for paid orgs as the shared SES quota (50,000 recipients a day, §6, item 4) grows.
SES costs ~$0.16 per 1,000, so 50,000 emails a month is ~$8.

**Free's 4,000 emails a month** counts recipients, because SES bills per recipient: one email to 3 people is 3.
(Assumption; the user said "emails".)

**Storage (user, 2026-11-19): 5 GB per organization on Free, 50 GB per organization on Growth at 5,000 people.** The pricing
page shows only the current total as the slider moves, not the per-100 rule.

- **What counts:** what the customer can see: each email once (its raw message, attachments included), Storage
  files with their kept versions, and trash. The internal `files` copies of mail attachments don't count, or every
  attachment would count twice (§6, item 2).
- **Over the limit:** the 10% grace, then Storage uploads and saves are refused. Mail always keeps arriving: SES
  accepts every message before xstate sees it, so a "452 mailbox full" isn't possible. Nothing is deleted.
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

**Billing in tiers, not by metering.** Growth is a Stripe subscription billed monthly in advance at the size the
organization picks. The usual 10% grace applies (§1). Above its size, owners and admins get an email every week;
moving up a size automatically is not decided. Settings → Billing shows the live count, split into emailed and
website people, so the bill is never a surprise.

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
  12 people, so on Free the 5-mailbox limit is what really applies, not the audience limit.
- **This org pays nothing under the new model**, yet costs about $2.40 a month. That is why Free keeps its 5-mailbox and 5 GB
  limits.

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

### Still open

1. **Measure a second, busier organization** once a real customer (or a sales or support mailbox) has a month of
   mail, to check the ~80-per-person figure.
2. Analytics event limits (§3a), proposed, not built.
3. Moving Growth up a size automatically when an organization stays over its size.
4. Whether bounce and system senders, and API sends from a no-reply mailbox, should count toward the audience.

---

## 9. Sources (read 2026-11-16 and 2026-11-19)

- Cloudflare Workers, Queues, Workflows, KV, D1, Durable Objects: https://developers.cloudflare.com/workers/platform/pricing/
- Observability from 2026-12-01: https://developers.cloudflare.com/observability/pricing/
- R2: https://developers.cloudflare.com/r2/pricing/ (Standard $0.015 per GB-month, Infrequent Access $0.01, egress free)
- Vectorize: https://developers.cloudflare.com/vectorize/platform/pricing/
- Workers AI and bge-m3 ($0.012 per million tokens): https://developers.cloudflare.com/workers-ai/platform/pricing/; toMarkdown is free for most formats
- Amazon SES: https://aws.amazon.com/ses/pricing/ (the old 12-month free tier is gone, replaced by AWS credits)
- EC2 t3.medium, Ohio, $0.0416 an hour (AWS pricing data file); EBS gp3 $0.08: https://aws.amazon.com/ebs/pricing/; IPv4: https://aws.amazon.com/vpc/pricing/
- Stripe: https://stripe.com/pricing
- Production usage: D1 queries and `wrangler r2 bucket info xstate-mail-blobs` on 2026-11-16; deepo `df`;
  vectors, org R2 bucket, MailboxStore size, mail volume and the SES bill on 2026-11-18
- Rows per analytics event: counted from `apps/api/src/audience/store.ts` on 2026-11-19 (not measured)
- Loops pricing: https://loops.so/pricing (read 2026-11-19): Free up to 1,000 subscribed contacts and 4,000 sends a month; $49 for 5,000 contacts, unlimited sends; no seat fees
