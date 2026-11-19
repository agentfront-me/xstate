# Analytics: developer reference

How xstate's website analytics works under the hood: what comes in, how it's stored, how each number is worked
out, and where to change things. For *why* it's built this way and what was decided, see
[analytics-plan.md](analytics-plan.md). For the customer guide, see `apps/web/content/docs/analytics.md`
(xstate.com/docs/analytics).

## 1. The parts

```
customer's site                       xstate API Worker                          per-organization Durable Object
────────────────                      ─────────────────                          ───────────────────────────────
<script> xstate.js  ──POST /v1/collect──▶ audience/collect.ts ──store.collect()──▶ AudienceStore (SQLite)
customer's server  ──POST /v1/collect──▶   key check, user hash,                    people, aliases, events,
  (secret key)                             bot filter, rate limit,                  sessions, funnels, segments…
                                           context (IP, geo, device, UTM)
mailboxes (MAIL_EVENTS queue) ─▶ mailbox/events.ts ─┐
SES bounces/complaints ─────────▶ jobs/ses-webhook.ts ┴─ audience/email.ts ─recordEmail()─▶ AudienceStore

dashboard / mobile / MCP ──▶ operations/audience.ts ──▶ audience/service.ts (access) ──▶ AudienceStore
```

| File | What it does |
| --- | --- |
| `apps/api/src/audience/snippet.ts` | The browser library served at `GET /js/xstate.js` (version in `SNIPPET_VERSION`). |
| `apps/api/src/audience/collect.ts` | `POST /v1/collect`: validation, keys, user hash, bots, rate limit, building each event's context. |
| `apps/api/src/audience/device.ts` | User-Agent → browser, OS, device type; `isBot`. |
| `apps/api/src/audience/channel.ts` | Channel rules (`channelOf`), click ids, `hostOf`, `sameSite`. |
| `apps/api/src/audience/store.ts` | `AudienceStore` Durable Object: schema, upgrades, collect, sessions, metrics, feed, funnels, Overview, retention. |
| `apps/api/src/audience/metrics.ts` | Person metrics (`applyEvent`, `applyEmail`, `addEngagement`, `identified`, `mergeMetrics`). |
| `apps/api/src/audience/email.ts` | Email activity → `recordEmail`; `counterparts`. |
| `apps/api/src/audience/funnels.ts` | Funnel schema and SQL (`funnelQuery`, `summarize`). |
| `apps/api/src/audience/overview.ts` | Overview periods, filters, totals, series and breakdown SQL. |
| `apps/api/src/audience/types.ts` | Shared types: `CollectItem`, `EventContext`, `Person`, `FeedEvent`, `METRICS`, segment conditions. |
| `apps/api/src/audience/service.ts` | Access checks (member, `audience.manage`, readable mailboxes), then calls the store. |
| `apps/api/src/operations/audience.ts` | HTTP routes + MCP tools (`analytics_*`, `audience_*`). |
| `apps/app/src/analytics/` | Web: `AnalyticsPage.tsx` (side list, install, live feed), `Overview.tsx`, `Funnels.tsx`, `api.ts`, `world-map.json`. |
| `apps/app/src/users/` | Users section: person panel metrics (`metrics.ts`), segment builder metric conditions. |
| `apps/mobile/src/sections/Analytics.tsx`, `src/app/(app)/event/[id].tsx`, `src/app/(app)/funnel/[id].tsx`, `src/lib/analytics.ts` | Mobile, read-only. |

One `AudienceStore` per organization: `env.AUDIENCE.get(env.AUDIENCE.idFromName(organizationId))`. Nothing about
one organization's visitors is ever in another's store. The store trusts its callers; all access checks are in
`service.ts`.

## 2. Collecting events

### 2.1 The browser snippet

```html
<script>window.xstate=window.xstate||function(){(xstate.q=xstate.q||[]).push(arguments)};xstate('init','pk_live_…')</script>
<script async src="https://api.xstate.com/js/xstate.js"></script>
```

| Call | Sends |
| --- | --- |
| `xstate('init', key, { autocapture, respectDoNotTrack, cookie })` | Stores the key, sends the first page view, hooks `pushState`/`replaceState`/`popstate`, scroll, clicks, `visibilitychange`, `pagehide`. |
| `xstate('page')` | A page view (also automatic on load and route changes). |
| `xstate('track', name, props)` | A `track` event. |
| `xstate('identify', userId, traits, userHash)` | An `identify`. With no `userId` it only describes the visitor's own lead. |
| `xstate('reset')` | Sends any `page_leave`, then forgets the visitor and visit ids (cookie and `localStorage`). |

Kept in a first-party cookie and in `localStorage` (memory if both are unavailable): `xstate_aid` (visitor id
`vis_…`) and `xstate_sid` (`{ id: 'ses_…', k: <attribution key>, t: <last activity ms> }`).

**Cross-subdomain (2.1.0).** The cookies are set on the top domain (`domain=acme.com`, `path=/`, `SameSite=Lax`,
`Secure` on https, one year), so `acme.com`, `www.acme.com` and `go.acme.com` share one visitor and one visit. The
top domain is found by trying to set a probe cookie `xstate_t` from the shortest candidate upward (`acme.com`,
then `shop.acme.com`…); the browser refuses public suffixes (`com`, `co.uk`), so the first that sticks is the
registrable domain and no suffix list ships with the snippet. Localhost and IP addresses get host-only cookies.
Reads prefer the cookie; an id found only in `localStorage` (pre-2.1.0 visitors) is copied into the cookie.
`cookie: false` keeps everything in `localStorage` only, per origin, as before 2.1.0. The server half of this is
the site rule in §3.2.

**Visits.** A new session starts when there is no session, after 30 minutes without activity, or when the first
page of a page load carries a *different* attribution key: `utm:<source>|<medium>|<campaign>`,
`click:<kind>`, or `ref:<external referring host>`. Only the first page of a load is checked (in a single-page app
`document.referrer` stays the original one).

**Every event carries `context`:** `session { id, start }`, `screen`, `viewport`, `locale`, `timezone`,
`library { name: 'xstate.js', version }`. On a session's first event also: `campaign`, `clickId { kind, value }`,
`referrer` (external referrers only).

**Engagement.** The snippet times how long each page is visible and its deepest scroll, and sends
`{ type: 'page_leave', url, properties: { duration_ms, scroll_depth } }` on route change, tab hidden and
`pagehide` (only when ≥ 1 s and changed since the last send). It is not stored as an event (see 3.3).

**Outbound links.** Clicks on `<a href>` to another site send `track $outbound_click { href, domain }` unless
`autocapture: false`.

**Off switch.** Nothing is sent when `navigator.webdriver`, or (unless `respectDoNotTrack: false`)
`navigator.globalPrivacyControl` or Do Not Track is set.

Events are queued for 300 ms and sent as `text/plain` JSON (no CORS preflight) with `keepalive`, 50 per request,
to the origin the script was loaded from.

### 2.2 `POST /v1/collect`

```jsonc
// Browser: publishable key in the body, site from the Origin header.
{ "key": "pk_live_…", "anonymousId": "vis_…", "events": [ { "type": "page", "url": "…", "properties": {…}, "context": {…}, "timestamp": "…" } ] }

// Server: Authorization: Bearer sk_live_…, no "key"; each event names its site.
{ "events": [ { "type": "track", "event": "Order Completed", "userId": "usr_1", "domain": "acme.com", "properties": { "revenue": 96 },
                "context": { "ip": "…", "userAgent": "…", "locale": "en-US", "campaign": {…}, "referrer": "…", "page": { "path": "/…" }, "sessionId": "…" } } ] }
```

A single event may be sent without the `events` array.

| Field | Rules |
| --- | --- |
| `type` | `identify`, `track`, `page`, `page_leave`. |
| `event` | Required for `track`, ≤ 100 chars. `$pageview`, `$identify`, `$email_*` are rejected (xstate records them). |
| `anonymousId` / `userId` / `email` | At least one must identify the person. `email` only with the secret key. |
| `userHash` | Browser `identify` with a `userId`: hex HMAC-SHA256(secret key, userId). Without a valid hash the `userId` is ignored. |
| `traits`, `properties` | JSON objects, dropped entirely if over 4 KB. |
| `timestamp` | ISO time; outside [now − 7 days, now + 5 min] it becomes now. |
| `domain` / `url` | Browser: the site is the `Origin` host (else the URL's). Server: `domain`, else the URL's host. `www.` and a trailing dot are stripped. |
| `context` | Optional; anything malformed in it is dropped, never the event (`.catch(undefined)`). |

Limits: 64 KB body, 50 events per request, browser requests 300 per minute per organization and IP
(`COLLECT_RATE` in `wrangler.jsonc`). Browsers get `202 { accepted }` without waiting for the write
(`waitUntil`); server calls wait and get `200 { accepted }`. Browser requests with a bot User-Agent get
`202 { accepted: 0 }` and are dropped before the rate limiter.

### 2.3 Event context (`EventContext`)

Built per event by `contextOf` in `collect.ts`. For browser calls the request supplies the network part; for
server calls only what the caller sends in `context` is used (no geolocation of a `context.ip`).

| Field | Browser source | Server source |
| --- | --- | --- |
| `sessionId`, `sessionStart` | `context.session` | `context.sessionId` |
| `path` | `context.page.path`, else the URL's path | same |
| `referrer`, `referringDomain` | `context.referrer` if it's another site | `context.referrer` / `context.page.referrer` |
| `campaign { source, medium, name, term, content }`, `clickId` | `context.campaign`, `context.clickId.kind` | same |
| `channel` | `channelOf(...)` when the event starts a visit or carries attribution | same |
| `ip` | `CF-Connecting-IP` | `context.ip` |
| `country`, `region`, `regionCode`, `city`, `postalCode`, `timezone`, `continent`, `isEu` | `request.cf` | — |
| `latitude`, `longitude` | `request.cf`, rounded to 0.1° (~10 km) | — |
| `asn`, `asOrganization` | `request.cf` | — |
| `browser`, `browserVersion`, `os`, `osVersion`, `deviceType` | `User-Agent` via `parseUserAgent` | `context.userAgent` |
| `screen`, `viewport`, `locale`, `library` | `context` | `context` |

### 2.4 Channels (`channelOf`)

Checked in this order; the first match wins.

1. **UTM medium**: `paid_social`/`paidsocial`… → Paid social; `cpc`/`ppc`/`paid`/`paid_search`/`sem`/`cpv`/`cpa`/`retargeting` → Paid search (Paid social if the source or referrer is a social network); `display`/`banner`/`cpm` → Display; contains `email`/`newsletter` → Email; `affiliate`/`partner` → Affiliate; `social`/`sm`/`organic_social` → Social; `organic` → Organic search; `referral` → Referral.
2. **Click id**: `gclid`/`gbraid`/`wbraid`/`msclkid` → Paid search; `ttclid`/`li_fat_id`/`twclid` → Paid social; `fbclid` → Social (Facebook adds it to every link).
3. **UTM source**: social names → Social; search engines → Organic search; `chatgpt`/`openai`/`perplexity`/`claude`/`gemini`/`copilot` → AI assistant; email/newsletter → Email.
4. **Referring domain**: AI apps → AI assistant; webmail (incl. `mail.google.com`) → Email; search engines → Organic search; social networks → Social; anything else → Referral.
5. A source or medium that matched nothing → Other; no attribution at all → Direct.

Lists are at the top of `channel.ts`. Add a domain there and add a case to `tracking.test.ts`.

## 3. Storage (`AudienceStore`)

SQLite inside the Durable Object. `SCHEMA` (all `CREATE … IF NOT EXISTS`) runs on every start; `UPGRADES[n]`
run once each, in order, tracked in `storage.get('schema_version')`. **Never edit an old upgrade; add a new
one.** Columns added by an upgrade must not also be in `SCHEMA` (a new store runs both).

| Upgrade | Change |
| --- | --- |
| 1 | Contacts: `people.owner_member_id`, email uniqueness per domain / per owner. |
| 2 | Analytics: `events.type/domain/session_id/path`, `people.metrics`, backfill type and domain, indexes. |
| 3 | `people_email_any` index (email activity finds people on any site). |
| 4 | `sessions.revenue/orders` (backfilled from events), `sessions_started` index. |
| 5 | `sites` table: the organization's verified domains as last seen; a change re-keys people (§3.2). |

### 3.1 Tables

**`people`**: one per (site, person). `id` (`per_…`), `kind` (`user` \| `lead` \| `contact`), `domain` (the site,
§3.2; `''` for contacts), `external_id` (your user id), `anonymous_id` (first visitor id), `name`, `email`, `phone`,
`source` (`Website`, `API`, `Test`, imports…), `attributes` (your JSON, ≤ 100 keys), `metrics` (xstate's JSON, §5),
`first_seen_at`, `last_seen_at`, `created_at`, `updated_at`, `owner_member_id` (contacts).

**`aliases`**: `(domain, anonymous_id) → person_id`, `domain` being the site. Every browser a person used.

**`events`**: `id` (autoincrement; the feed's order and cursor), `person_id`, `type` (`page` \| `track` \|
`identify` \| `email`), `name` (`$pageview`, `$identify`, `$email_*`, `$outbound_click` or yours), `properties`
(JSON; `identify` keeps the traits here), `url`, `domain`, `session_id`, `path`, `occurred_at`.

**`sessions`**: one per visit. `id` (from the snippet), `person_id`, `domain`, `started_at`, `ended_at`,
`pageviews`, `events`, `engaged_ms`, `landing_path`, `exit_path`, `channel`, `referrer`, `referring_domain`,
`utm_source/medium/campaign/term/content`, `click_id` (kind), `ip` (NULL when IP keeping is off, and after 90 days),
`country`, `region`, `city`, `postal_code`, `timezone`, `latitude`, `longitude`, `continent`, `asn`, `as_org`,
`browser`, `browser_version`, `os`, `os_version`, `device_type`, `screen`, `viewport`, `locale`, `library`,
`revenue`, `orders`.

**`event_names`** (`name`, `total`, `last_at`) and **`attribute_defs`** (`key`, `type`, `created_at`): pickers.

**`segments`**: saved filters (JSON), compiled to SQL on read (`where` / `compile` in `store.ts`).

**`funnels`** (`id`, `name`, `steps` JSON, `window_days`, `position`…) and **`funnel_cache`**
(`funnel_id`, `key` = `range|domain`, `result`, `computed_at`).

Durable Object storage key `analytics_settings` holds `{ storeIp: boolean }` (default true).

### 3.2 Who an event belongs to (`resolve` / `identify`)

**Sites (`site.ts`).** People and aliases are kept per *site*, not per hostname: the longest of the organization's
verified domains that the event's hostname is or ends in (`go.acme.com` → `acme.com`), else the hostname itself.
`collect.ts` reads the verified domains from D1 (cached 5 minutes per isolate) and sends them with the batch; events
and sessions keep the exact hostname in `domain`. When the list differs from the store's `sites` table, the store
re-keys first (`useSites` → `rekey`): people on a hostname move to its site, and where the site already has the same
person (same `external_id`, or same email) they are merged, a user keeping a lead's history. Two different users
sharing an email stay on their hostnames. Aliases move too; a visitor id seen on both keeps the site's person.

- `userId` (trusted) → the person with that `external_id` on the site, created as a `user` if new; the visitor id
  becomes an alias.
- Else `anonymousId` → the person behind that alias, created as a `lead` if new.
- Else (server only) `email` → the person with that email on the site, created as a `lead` if new.
- `identify` with a trusted `userId`: a lead becomes that user (`metrics.identified_at`, `days_to_identify`); if the
  user already exists, the lead is **merged** into it (events, aliases and sessions move; attributes and metrics are
  combined with `mergeMetrics`) and deleted.
- Traits: `name`, `email`, `phone` update the profile (a browser without a hash may only change its own lead; an
  email someone else has is left alone); everything else becomes an attribute.

### 3.3 What one event writes (`collectOne`)

1. Find or create the person (3.2).
2. `page_leave`: update the newest `$pageview` of that path in the visit: `duration_ms` and `scroll_depth` only
   grow; the growth is added to `sessions.engaged_ms` and `metrics.engaged_ms`. Nothing else.
3. `visit()`: open the session on first sight (all context columns) or update it (`ended_at`, counters,
   `exit_path` for pages). A session id that belongs to another person is ignored.
4. Insert the event, bump `event_names`.
5. `creditRevenue()`: a numeric `revenue` property adds to the visit's `revenue`/`orders`; with no visit, to the
   person's latest session that started in the 30 days before.
6. `applyEvent()` the person's metrics; update `last_seen_at`.

All of a batch runs in one `transactionSync`.

### 3.4 Retention (daily alarm)

| What | Kept |
| --- | --- |
| Events | 90 days (`EVENT_RETENTION_DAYS`) |
| Sessions | 180 days (`SESSION_RETENTION_DAYS`); `ip` cleared after 90 |
| Anonymous leads (no email, no phone) | 30 days after last seen (`ANONYMOUS_RETENTION_DAYS`), with their events and sessions |
| Turning IP keeping off | clears every stored `ip` at once |

## 4. Event names

| Name | Type | From |
| --- | --- | --- |
| `$pageview` | `page` | snippet / `page` calls. Properties: `path`, `title`, `search`, `hash`, `referrer` (first page), later `duration_ms`, `scroll_depth`. |
| `$identify` | `identify` | `identify` calls; properties are the traits. |
| `$outbound_click` | `track` | snippet autocapture: `href`, `domain`. |
| `$email_received`, `$email_replied`, `$email_sent`, `$email_bounced`, `$email_complained` | `email` | §6. Properties: `mailbox`, `mailbox_id`, `address`, `email_id`, `detail`. |
| anything else | `track` | your `track` calls. A numeric `revenue` (and `currency`) counts as an order. |

## 5. Person metrics (`people.metrics`)

Worked out by `metrics.ts` on every event; never set by customers. `METRICS` in `types.ts` lists the ones a segment
can filter on (with types); the app labels them in `apps/app/src/users/metrics.ts`.

| Group | Keys |
| --- | --- |
| First touch | `initial_channel`, `initial_utm_source/medium/campaign/term/content`, `initial_click_id`, `initial_referrer`, `initial_referring_domain`, `initial_landing_page` |
| Last touch | `last_channel`, `last_utm_*`, `last_click_id`, `last_referring_domain` |
| Location | `country`, `region`, `city`, `timezone` (latest), `first_country` |
| Device | `last_browser`, `last_os`, `last_device_type`; `devices_used` is added when a person is read (alias count) |
| Activity | `sessions`, `pageviews`, `events`, `active_days`, `last_active_day`, `engaged_ms`, `engaged_seconds`, `last_event`, `last_page` |
| Revenue | `revenue_total`, `orders`, `currency`, `first_order_at` |
| Email | `emails_received`, `emails_replied`, `emails_sent`, `last_email_at`, `email_bounced`, `email_complained` |
| Lifecycle | `identified_at`, `days_to_identify` |

First touch is set once, on the first event that has a channel (Direct included). Segment condition:
`{ kind: 'metric', key, op, value }`, compiled like attributes but on `json_extract(p.metrics, …)`.

## 6. Email activity

`audience/email.ts` → `AudienceStore.recordEmail`.

- **Sent / received / replied**: `mailbox/events.ts` (the `MAIL_EVENTS` consumer) for `kind: 'new'`.
  `direction: 'out'` → `$email_sent` to `to`/`cc`/`bcc`; `'in'` → `$email_received` from `from`, plus
  `$email_replied` when the message has `In-Reply-To`. Skipped for `offer: false` (imports, catch-up), Junk and
  infected mail. The mailbox's own address and aliases are never counterparts.
- **Bounced / complained**: `jobs/ses-webhook.ts`, for the sending mailbox.
- Only **website people** (not contacts) whose `email` matches, on any site; mail never creates people.
- No subject or body is stored. `email_id` makes queue retries a no-op.
- Received and replied count as activity (`last_seen_at`); sent doesn't.
- **Visibility**: `analytics_events` / `analytics_event` hide email events of mailboxes the viewer can't read
  (`readableMailboxes`, which also honours a connected app's `actor.mailboxIds`). The person timeline leaves email
  events out (it shows the mail itself). The CSV export leaves the email counts out.

## 7. Funnels (`funnels.ts`)

Steps (2–10): `{ type: 'page', match: '/path' | '/section/*' }`, `{ type: 'track', match: 'Event Name' }`,
`{ type: 'email', match: '$email_…' }`. Window 1–90 days (default 7). Ranges 7 / 30 / 90 days.

`funnelQuery` builds chained CTEs, one per step, each giving per person the time they reached it:

```sql
s0 AS (first matching event per person since <range start> [on the site])
s1 AS (first matching event at or after s0.t and ≤ s0.t + window)   -- per person in s0
s2 AS (… at or after s1.t …)
SELECT s0.t AS t0, s1.t AS t1, … FROM s0 LEFT JOIN s1 … LEFT JOIN s2 …
```

`summarize` counts people per step, drop-off from the previous step and the median gap. Page steps match `path`
with `GLOB` (`*` wildcard; `[`, `]`, `?` escaped). Times use `>=` so events with the same timestamp still chain.
Results are cached 5 minutes per range + domain in `funnel_cache` and cleared when the funnel is saved. Up to
50 funnels per organization. The whole result loads one row per person who did step 1, fine into the hundreds of
thousands.

## 8. Overview (`overview.ts`)

Everything but the page and event lists reads **sessions**, so periods up to 90 days can be compared with the 90
before.

| Number | Definition |
| --- | --- |
| Visitors | `count(DISTINCT person_id)` |
| Visits | `count(*)` |
| Page views | `sum(pageviews)` |
| Bounce rate | visits with ≤ 1 page view and under 10 s ÷ visits |
| Avg. visit duration | mean of `max(ended_at − started_at, engaged_ms)` |
| Revenue, orders | `sum(revenue)`, `sum(orders)` |
| Live | distinct people with a page or track event in the last 5 minutes (ignores filters) |
| Conversion (per channel/campaign) | visits with an order ÷ visits |

**Periods** (`periodOf`): `today` = local midnight → now, hourly buckets; `7`/`30`/`90` = that many local days
ending today, daily buckets. The previous period is the same length right before. Local time comes from the
client's `tzOffset` (`Date.getTimezoneOffset()`), applied in SQL as a `'+300 minutes'` modifier.

**Breakdown dimensions** and their keys:

| Dimension | Key | Source |
| --- | --- | --- |
| `channel` | channel (NULL → Direct) | sessions |
| `referrer` | `referring_domain` (visits without one left out) | sessions |
| `campaign` | `source\|medium\|campaign` | sessions |
| `landing`, `exit` | `landing_path`, `exit_path` | sessions |
| `country` | ISO alpha-2 | sessions |
| `region`, `city` | `name\|country` | sessions |
| `device`, `browser`, `os` | `device_type`, `browser`, `os` | sessions |
| `page` | `path` of `$pageview`s, visitors = distinct people | events ⨝ sessions |
| `event` | your `track` names (not `$…`), count and people | events ⨝ sessions |

**Filters** (≤ 6, one per dimension in the app): session dimensions compare the same key expression; `page` and
`event` filter visits with `EXISTS` on events. Results are cached 60 s in the store's memory.

The web map (`apps/app/src/analytics/world-map.json`) is 174 country outlines pre-projected (Natural Earth,
800×400) from `world-atlas` 110m and keyed by alpha-2 (Kosovo = `XK`); it's loaded only by the Overview. To
regenerate it, project `countries-110m.json` with `d3-geo` and map numeric ids with `i18n-iso-countries`.

## 9. API

All under `/v1`, Bearer session token, organization member required. "MCP" = also a tool for connected AI apps
(scope `contacts.read`, read-only).

| Operation | Route | MCP | Notes |
| --- | --- | --- | --- |
| `analytics_status` | `GET /analytics/orgs/:org/status?domain` | | `lastEventAt`, `publishableKey`, `settings`, `canManage` |
| `analytics_events` | `GET /analytics/orgs/:org/events?domain&type&q&before&after&limit` | ✓ | newest first; `after` for polling, `before` for paging; `recent` = last 5 min |
| `analytics_event` | `GET /analytics/orgs/:org/events/:id` | ✓ | event + its session row as `visit` |
| `analytics_test_event` | `POST /analytics/orgs/:org/test-event { domain }` | | identify "Test visitor" + track "Test Event" |
| `analytics_update_settings` | `PATCH /analytics/orgs/:org/settings { storeIp }` | | needs `audience.manage` |
| `analytics_overview` | `GET /analytics/orgs/:org/overview?range&tzOffset&domain&filters` | ✓ | `filters` is JSON `[{ dim, value }]` |
| `analytics_breakdown` | `GET /analytics/orgs/:org/breakdown?…&dimensions=a,b&limit` | ✓ | lists per dimension + totals |
| `analytics_funnels` | `GET /analytics/orgs/:org/funnels?domain` | ✓ | each with 30-day `conversion` |
| `analytics_funnel_result` | `GET /analytics/orgs/:org/funnels/:id/result?range&domain` | ✓ | |
| `analytics_funnel_options` | `GET /analytics/orgs/:org/funnel-options` | | your event names, top 100 paths |
| `analytics_create_funnel` / `update` / `delete` | `POST` / `PUT` / `DELETE /analytics/orgs/:org/funnels[/:id]` | | need `audience.manage` |
| `audience_*` | `/audience/orgs/:org/…` | some | people, segments (incl. `metric` conditions), CSV |
| `api_keys_*` | `/orgs/:org/api-keys…` | | owners and admins |

Public, no session: `POST /v1/collect`, `GET /js/xstate.js`.

After adding or changing an MCP operation, run `pnpm --filter @xstate/api docs:mcp` (the API's `pnpm test`
checks `apps/web/content/docs/mcp.md` is current).

## 10. Permissions and privacy rules

- Any member: see Analytics, people (not other members' contacts), funnels, Overview.
- `audience.manage` (owners and admins have it): settings, funnels, segments, website people.
- Owners and admins: API keys.
- Email events: only for mailboxes the viewer can read.
- Documented promises that code must keep: IP kept ≤ 90 days and removable; locations to ~10 km; no favicons or
  other third-party fetches of referrer domains; GPC/DNT honoured by default; no email subjects or bodies in
  analytics. Any change to these updates `apps/web/content/docs/security.md` and `privacy.md`.

## 11. Testing and local work

```bash
pnpm --filter @xstate/api test        # includes audience/tracking.test.ts, funnels.test.ts, overview.test.ts
pnpm --filter @xstate/api typecheck
```

`funnels.test.ts` and `overview.test.ts` run the real SQL on `node:sqlite` with the same columns as the store;
when you change a table the store queries, change their `CREATE TABLE` too.

Local: start the API (`api` in `.claude/launch.json`, port 8788). Publishable keys:

```bash
cd apps/api && npx wrangler d1 execute xstate --local --command "SELECT organization_id, publishable_key FROM api_keys"
```

Send events (the `Origin` sets the site; `User-Agent` must look like a browser):

```bash
curl -X POST http://localhost:8788/v1/collect -H 'Content-Type: text/plain' -H 'Origin: https://shop.test' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' \
  --data '{"key":"pk_live_…","anonymousId":"vis_dev1","events":[{"type":"page","url":"https://shop.test/?utm_source=google&utm_medium=cpc","context":{"session":{"id":"ses_dev1","start":true},"campaign":{"source":"google","medium":"cpc"}}}]}'
```

Local `request.cf` is Cloudflare's view of your own connection, so every local visit gets your location. To read a
store directly, open its SQLite file read-only with `node:sqlite`:
`apps/api/.wrangler/state/v3/do/xstate-api-AudienceStore/<hash>.sqlite` (find the file by a visitor id you sent).

## 12. Extending

- **A new tracked field** (say, the page's language): send it in the snippet's `context`, add it to the `context`
  schema in `collect.ts` and to `EventContext`, add a `sessions` column in a **new upgrade**, write it in `visit()`.
  Bump `SNIPPET_VERSION`.
- **A new person metric**: update `applyEvent` (and `mergeMetrics` if it's a counter), add it to `METRICS` in
  `types.ts` if segments should filter on it, label it in `apps/app/src/users/metrics.ts` (and mobile
  `lib/analytics.ts`), add a test.
- **A new Overview dimension**: add it to `DIMENSIONS`, `SESSION_KEY` (and `SESSION_PRESENT`) in `overview.ts`,
  to the app's `Dimension` type, `LIST_DIMS`, labels, and the router's `filtersOf` list.
- **A new event source** inside xstate (like email): call a store method from the producer, never `collect`
  (that's for customers' events), use a `$`-prefixed name and add it to `RESERVED` in `collect.ts`.
- **Scale**: each organization's store is one SQLite database (10 GB limit). Per-event rows are kept small on
  purpose; per-visit data lives in `sessions`. If one organization outgrows it, move raw events out (Analytics
  Engine or R2) and keep people, sessions and metrics in the store.
