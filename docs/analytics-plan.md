# Analytics plan

Status: plan agreed 2026-11-18 (decisions in section 11). All phases built 2026-11-18 (sections 12–18); phase 6 (Overview) is uncommitted.

The design (Claude Design, "xstate App", Analytics page) adds an **Analytics** section to the rail. Today the data
already flows in (`POST /v1/collect` → the organization's `AudienceStore` Durable Object), but the only place it
shows up is the per-person timeline in Users. This plan makes that data visible, and makes it worth looking at by
collecting more of it automatically.

## 1. What the design asks for

| Screen | What it shows |
| --- | --- |
| **Connect analytics** (no events yet) | "Install with an AI agent" (copy prompt), Browser / Server install code with the publishable key, "Waiting for your first event" + **Send test event**. |
| **Live events** | Live feed with a Pause button, "N events in the last 5 min", search (event or user), type tabs **All · Page · Track · Email · Identify**, columns Type / Event / User / Properties / Time. Clicking a row opens a side panel with the full event JSON (properties, `context.library`, `context.ip`, `context.locale`, timestamp). |
| **Funnels** (sidebar list, each with its 30-day conversion %) | Name, "4 steps · 7 day conversion window", date range (Last 30 days), overall conversion, a bar per step, and a table: Users / From previous / Dropped / Median time. |
| **Edit funnel** dialog | Name; ordered steps, each "Page · Viewed /products/\*", "Track · Added to Cart" or an Email step; Add step; Save. |
| **Install code** (sidebar footer) | The install screen again, once connected. |

The "Support email to order" funnel mixes **Email Received → Email Sent → Email Opened → Order Completed**, so email
activity from connected mailboxes is expected to be part of the event stream.

## 2. What exists today

- `apps/api/src/audience/snippet.ts`: `xstate('init' | 'identify' | 'track' | 'page' | 'reset')`, anonymous id in
  localStorage, automatic page views (sends `title` and `referrer` only).
- `apps/api/src/audience/collect.ts`: checks the publishable/secret key and the user hash, rate-limits by IP,
  takes the domain from `Origin`. **Throws away** the IP, `request.cf` (geo) and the User-Agent.
- `apps/api/src/audience/store.ts`: `people`, `aliases`, `events (person_id, name, properties, url, occurred_at)`,
  `event_names`, `attribute_defs`, `segments`. Identify calls are **not** stored as events. 90-day event retention,
  anonymous leads deleted after 30 days.
- App: Users page with segments, PersonPanel timeline (website events + emails). No Analytics route
  (`apps/app/src/app/pages.tsx`).
- Email: no audience events from mail. Delivered / bounced / complained exist only for API-sent mail (`api_emails`).
  No open tracking anywhere.

## 3. What we collect automatically (new)

Everything below needs no code from the customer beyond the existing snippet.

### 3.1 In the browser (snippet v2)

| Group | Fields |
| --- | --- |
| Campaign (UTM) | `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, read from the landing URL |
| Ad click ids | `gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `ttclid`, `li_fat_id`, `twclid` (presence + value) |
| Referral | `referrer` (full), `referring_domain`, plus `ref` / `via` / `source` query params some sites use |
| Page | `path`, `search`, `hash`, `title`, `url` |
| Session | `session_id`: new after 30 min of inactivity, or when the UTM campaign / referring domain changes (same rule as GA) |
| Screen | `screen` (w×h), `viewport` (w×h), `pixel_ratio` |
| Locale | `navigator.language`, time zone (`Intl…timeZone`) |
| Library | `library: { name: 'xstate.js', version }` |
| Engagement | time on page and max scroll depth, sent with the next page view or on `visibilitychange: hidden` (as `$page_leave`) |
| Outbound links | `$outbound_click` with the destination domain (opt-out with `xstate('init', key, { autocapture: false })`) |

The UTM / referrer / click-id values are sent on the first page view of each session only, so they don't bloat
every event.

### 3.2 On the server (collect.ts, from the request)

| Group | Fields | Source |
| --- | --- | --- |
| IP | `ip` | `CF-Connecting-IP` |
| Location | `country`, `region`, `region_code`, `city`, `postal_code`, `timezone`, `latitude`, `longitude`, `continent`, `is_eu` | `request.cf` (free on every Worker request, no GeoIP database needed) |
| Network | `asn`, `as_organization` (e.g. "Comcast", "Amazon") | `request.cf` |
| Device | `browser` + version, `os` + version, `device_type` (desktop / mobile / tablet), `device_brand` for common phones | parsed User-Agent (small in-house parser, no dependency) |
| Bots | requests from known crawlers / headless browsers are **dropped**, not stored | User-Agent patterns + `cf.asOrganization` of hosting providers for anonymous traffic |
| Channel | `channel`: Direct, Organic search, Paid search, Social, Paid social, Email, Referral, Affiliate, AI assistant (chatgpt.com, perplexity.ai, claude.ai, gemini…) | derived from UTM medium/source + referring domain |

Server-side calls (secret key) carry no browser, so they get no geo/device unless the caller sends
`context: { ip, userAgent, locale, campaign: {…}, page: {…} }` (Segment-compatible). We store what they send; we
don't geolocate an arbitrary `context.ip` (that needs a GeoIP database; can be added later).

### 3.3 From email (automatic, for connected mailboxes)

Recorded only for addresses that already belong to someone in the audience (a website person or a contact), so
spam and one-off mail don't create people.

| Event | When |
| --- | --- |
| `$email_received` | a message from the person arrives in any of the organization's mailboxes (`mailbox/receive.ts`, which already calls `AudienceStore.knows`) |
| `$email_sent` | a member or an agent sends to the person (`sendMessage`), incl. the transactional API |
| `$email_replied` | a sent message is a reply in a thread the person started |
| `$email_bounced` / `$email_complained` | from the SES webhook, which already parses these |

Properties: mailbox address, subject, thread id. No bodies.

**Recommendation on "Email Opened":** don't build it for normal mail. It needs a tracking pixel inserted into every
message members send, which is a privacy problem for a business email product, and Apple Mail Privacy Protection
makes it ~50% fake opens anyway. Use **Email Replied** in the "Support email to order" funnel instead. If opens are
wanted later, do it only for the transactional API with an explicit `track: { opens: true }` flag.

## 4. Metrics per person (new)

Stored in a separate `metrics` JSON on `people` (`Person.metrics`), never mixed with the customer's own `attributes`, so they
don't count toward the 100-attribute cap and a browser can't overwrite them. All of them become segment conditions.

| Group | Metrics |
| --- | --- |
| First touch | `initial_channel`, `initial_utm_*`, `initial_referrer`, `initial_referring_domain`, `initial_landing_page`, `initial_click_id` kind |
| Last touch | `last_channel`, `last_utm_*`, `last_referring_domain` |
| Location | `country`, `region`, `city`, `timezone` (latest), `first_country` |
| Device | `last_browser`, `last_os`, `last_device_type`, `devices_used` (count of distinct anonymous ids) |
| Activity | `sessions`, `pageviews`, `events`, `active_days`, `avg_session_seconds`, `last_event`, `last_page` |
| Email | `emails_received`, `emails_sent`, `last_email_at`, `email_bounced` (bool) |
| Revenue | `revenue_total`, `orders` (sum/count of a `revenue` property on any event, with `currency`), `first_order_at` |
| Lifecycle | `identified_at` (lead → user), `days_to_identify`, `first_seen_at`, `last_seen_at` (exist) |

Counters are updated in the same transaction as the event insert, so they are free to read.

## 5. Data model changes (AudienceStore, upgrade step 2)

The DO's SQLite has a 10 GB cap per organization. A busy site writes many events, so the rule is: **per-event rows
stay small; everything that's the same for a whole visit goes on the session.**

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,            -- from the snippet, or made up for server calls
  person_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 0, events INTEGER NOT NULL DEFAULT 0,
  landing_path TEXT, exit_path TEXT,
  channel TEXT, referrer TEXT, referring_domain TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT, click_id TEXT,
  ip TEXT, country TEXT, region TEXT, city TEXT, timezone TEXT, asn INTEGER, as_org TEXT,
  browser TEXT, os TEXT, device_type TEXT, screen TEXT, locale TEXT, library TEXT
);
CREATE INDEX sessions_time ON sessions (domain, started_at);
CREATE INDEX sessions_person ON sessions (person_id, started_at);

ALTER TABLE events ADD COLUMN type TEXT NOT NULL DEFAULT 'track';   -- page | track | identify | email
ALTER TABLE events ADD COLUMN domain TEXT;
ALTER TABLE events ADD COLUMN session_id TEXT;
ALTER TABLE events ADD COLUMN path TEXT;                             -- for "Viewed /products/*" steps
CREATE INDEX events_name_time ON events (name, occurred_at);
CREATE INDEX events_domain_time ON events (domain, occurred_at DESC, id DESC);

ALTER TABLE people ADD COLUMN metrics TEXT NOT NULL DEFAULT '{}';    -- section 4

CREATE TABLE funnels (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  steps TEXT NOT NULL,            -- [{ type: 'page'|'track'|'email', match: '/products/*' | 'Added to Cart' }]
  window_days INTEGER NOT NULL DEFAULT 7,
  position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE funnel_cache (funnel_id TEXT, range TEXT, result TEXT, computed_at TEXT, PRIMARY KEY (funnel_id, range));
```

- Identify calls are stored as `$identify` events (the design lists them), with the traits that changed.
- The event detail panel rebuilds the design's JSON from the event row + its session (`context.ip`, `locale`,
  `library`, geo, device, campaign).
- Old events have no session; they show without context. No backfill is possible.
- Retention is unchanged: events and sessions 90 days, anonymous leads 30 days.

**Scale fallback (not now):** if one organization nears the DO size limit, move raw events to Workers Analytics
Engine or R2 and keep only people, sessions and counters in the DO. The per-org DO stays the source of truth until
then, because funnels and timelines need per-person event order.

## 6. API (operations, same auth as Users)

| Operation | Path | Notes |
| --- | --- | --- |
| `analytics_status` | `GET /analytics/orgs/:org/status` | has any event, last event time, keys, snippet (drives the empty state) |
| `analytics_events` | `GET /analytics/orgs/:org/events?domain&type&q&before&after&limit` | newest first; `after=<id>` for live polling; joins person name/email and session context |
| `analytics_event` | `GET …/events/:id` | the full JSON for the side panel |
| `analytics_test_event` | `POST …/test-event` | sends a `Test Event` through the real collect path |
| `analytics_funnels_*` | list / create / update / delete / reorder | create and edit need the same manage permission as segments |
| `analytics_funnel_result` | `GET …/funnels/:id/result?range=7d\|30d\|90d&domain` | cached 5 min; the sidebar % reads the cached 30-day result |

**Live feed: poll, don't push.** While Live events is on screen and not paused, the app asks for `after=<last id>`
every 3 s (stops when the tab is hidden). It reuses the normal operation auth and the existing indexes, and costs
nothing when nobody is looking. Pushing every event through a WebSocket would add work to the hot collect path for
every customer's website. We can move to the existing `LiveHub` later if 3 s feels slow.

**Funnel computation:** ordered, per person, within the window, in the DO with chained CTEs (step *k* = first
matching event after step *k−1* and before step 1 + window). Up to 10 steps. Page steps match `path` with `*` as a
wildcard. Median time between steps is computed from the per-person timestamps. Counts are **people** (users and
anonymous visitors), as in the design.

## 7. App (web)

- `pages.tsx`: add `{ id: 'analytics', label: 'Analytics', icon: 'chart-line' }` after Users; route `/analytics` with
  `?view=live|funnel&funnel=<id>`.
- `apps/app/src/analytics/`: `AnalyticsPage` (sidebar: Live events, Funnels, New funnel, Install code),
  `LiveEvents`, `EventPanel`, `FunnelView`, `FunnelDialog`, `InstallCode`, `api.ts`.
- Domain switcher ("All domains") filters everything, as it does for Users.
- User column links to the person in Users.
- **Install code:** show the snippet that really exists (`xstate('init', 'pk_live_…')` from
  `api.xstate.com/js/xstate.js`), not the design's `xstate.load` / `cdn.xstate.com`, unless we decide to add a CDN
  host. The AI-agent prompt is generated with the org's publishable key and links to the docs page.
- PersonPanel: new **Acquisition** (first/last touch), **Location & device** and **Activity** sections from
  section 4. Users table: optional Country and Channel columns.
- Segment builder: new condition kinds for the computed metrics (country, channel, initial UTM, device type,
  sessions, revenue, emails).

## 8. Beyond the design (recommended)

The design has no place to see the UTM / referral / location data in aggregate; it only shows up inside single
events. I recommend one more sidebar item, **Overview**, designed in Claude Design first:

- Visitors, sessions, page views, bounce rate, avg session length, with a chart over the range.
- Top **channels**, **sources / referrers**, **UTM campaigns**, **landing pages**, **pages**, **countries / cities**,
  **browsers / OS / devices**. Each row clickable to filter the rest (and Live events).
- Built entirely from `sessions` and `events` with indexed GROUP BYs.

Without it, the automatic tracking in section 3 is mostly invisible.

## 9. Privacy and security

- We are a processor for our customers' visitors. IP + precise location is personal data under GDPR.
  **Recommendation:** store the full IP on the session (it's in the design) and keep it 90 days like events, with an
  organization setting **"Don't store IP addresses"** that keeps only country/region/city. Never store lat/long
  finer than city.
- Honour `navigator.globalPrivacyControl` and DNT: when set, the snippet sends no events (setting, default on).
- Update `apps/web/content/docs/privacy.md` (what we collect for customers) and
  `apps/web/content/docs/security.md` (new data, retention, IP setting), as required with every security change.
- New public docs page `apps/web/content/docs/analytics.md`: install, identify with user hash, auto-captured fields,
  UTM, email events, server `context`.

## 10. Phases

1. **Collection:** snippet v2 (UTM, click ids, sessions, screen, locale, engagement), collect enrichment (IP, geo,
   UA, bots, channel), sessions table, new event columns, `$identify` events, person computed metrics.
2. **Analytics page + Live events:** route, sidebar, empty state / install code / AI prompt / test event, live feed
   with polling, type tabs, search, event panel.
3. **Email events:** received / sent / replied / bounced into the audience.
4. **Funnels:** table, CRUD, computation + cache, view, editor, sidebar %.
5. **People:** PersonPanel sections, Users columns, segment conditions for the new metrics.
6. **Overview dashboard** (after it's designed).
7. **Docs, privacy/security pages, MCP tools** (`analytics_events`, `analytics_funnel_result`), mobile Analytics
   screen (read-only Live events + funnels).

Plan limits (events per month per plan) are left to the pricing task, like storage.

## 11. Decisions (agreed 2026-11-18)

1. IP addresses: store the full IP on the session for 90 days, with an organization setting "Don't store IP
   addresses" that keeps only country / region / city.
2. Email Opened: not built. Funnels use Email Replied instead; opens may come later for the transactional API only,
   behind an explicit flag.
3. Overview dashboard: yes, as phase 6, designed in Claude Design first.
4. Install code: keep the current `xstate('init', …)` snippet from `api.xstate.com/js/xstate.js`; the design's
   `xstate.load` / `cdn.xstate.com` text gets updated to match.

## 12. Phase 1 as built (2026-11-18)

- `audience/device.ts`: User-Agent → browser, OS (major versions), device type; `isBot`. Bot requests get a 202 and
  are dropped before the rate limit.
- `audience/channel.ts`: `channelOf` (UTM medium → click id → source → referring domain), `hostOf`, `sameSite`.
- `audience/metrics.ts`: the person metrics of section 4 (`applyEvent`, `addEngagement`, `identified`,
  `mergeMetrics`). `devices_used` is counted from aliases when a person is read.
- `audience/collect.ts`: builds an `EventContext` per event: IP, `request.cf` geo (lat/long rounded to 0.1°), ASN,
  device for browsers; `context` from the snippet or a server (`ip`, `userAgent`, `locale`, `campaign`, `referrer`,
  `page`, `sessionId`). Channel is set on a visit's first page or whenever attribution is present. `$pageview`,
  `$identify` and `$email_*` can't be sent as track names.
- `audience/snippet.ts` v2.0.0: sessions in localStorage (`xstate_sid`; 30 min idle or a new campaign/referrer),
  UTM + click ids + external referrer on the visit's first page, screen/viewport/locale/time zone/library on every
  event, `page_leave` (time visible, scroll depth) on route change / tab hidden / pagehide, `$outbound_click`,
  GPC/DNT/webdriver off switch, `init` options `autocapture` and `respectDoNotTrack`.
- `audience/store.ts`: `sessions` table, upgrade 2 (events `type`, `domain`, `session_id`, `path`; people
  `metrics`; backfill of type and domain; indexes). `$identify` events stored with the traits as properties.
  `page_leave` updates the latest view of that path in the visit (only growth counts) and the session's
  `engaged_ms`; it is not an event. Sessions follow merges, are deleted with people and after 90 days.
  `getSettings` / `setSettings({ storeIp })` exist on the store (turning IP off also clears stored IPs) but
  **no operation or UI yet**: that comes with the Analytics page (phase 2).
- App: `Person.metrics`, `AudienceEvent.type/sessionId` types; PersonPanel timeline names `$identify` and
  `$outbound_click` and hides path/search/hash chips on page views.
- Docs: `apps/web/content/docs/analytics.md` (customer install guide), security.md and privacy.md updated.
- Tests: `audience/tracking.test.ts`. Checked against the local API with curl and a real page using the snippet.

## 13. Phase 2 as built (2026-11-18)

- API (`operations/audience.ts`, all `mcp: false`): `analytics_status` (last event time, publishable key for any
  member, settings, canManage), `analytics_events` (newest first; `after` for polling, `before` for paging; `type`,
  `q`, `domain`; returns `recent` = events in the last 5 min), `analytics_event` (event + its visit row),
  `analytics_test_event` (identify "Test visitor" + track "Test Event" through `store.collect`, anonymous id
  `vis_test_<member>`), `analytics_update_settings` (`storeIp`, needs audience.manage).
- Store: `analyticsStatus`, `listEvents`, `getEvent`. Feed is ordered by event id (arrival order).
- App: rail entry **Analytics** (`chart-line`), route `#/analytics?view=install&type=&q=&event=`,
  `apps/app/src/analytics/` (`AnalyticsPage.tsx`, `api.ts`), `styles/analytics.css`, icons `chart-line`,
  `activity`, `pause`, `code-xml`.
  - Connect analytics (no events yet): AI-agent prompt with the key, Browser / Server code, "Waiting for your
    first event" (status polled every 3 s) + Send test event, Keep IP addresses switch. Same screen as **Install
    code** once connected.
  - Live events: polls `after=<newest id>` every 3 s while visible and not paused, keeps up to 500 rows, type tabs,
    search, Load more, event panel with the JSON (`eventJson` builds context from the visit), Open person, Copy JSON.
  - Funnels are not in the side list yet (phase 4).
- Checked in the browser against the local API: install screen → test event → live feed, page/track/identify rows,
  filters, search, pause, panel JSON, IP switch on/off, narrow widths. No console errors.

## 14. Phase 3 as built (2026-11-18)

- `audience/email.ts`: `recordEmailActivity` (never throws) and `counterparts` (the other side of a message,
  without the mailbox's own address and aliases).
- Hooks: `mailbox/events.ts` (the MAIL_EVENTS consumer) records `$email_sent` for `direction: 'out'`, and
  `$email_received` (+ `$email_replied` when the message has In-Reply-To) for `'in'`; skipped for `offer: false`
  (imports, catch-up), Junk and infected mail. `jobs/ses-webhook.ts` records `$email_bounced` / `$email_complained`
  for the sending mailbox.
- Store `recordEmail`: matches website people (not contacts) by email on any domain (new index `people_email_any`,
  upgrade 3); event type `email`, properties `mailbox`, `mailbox_id`, `address`, `email_id` (dedupes retries),
  `detail` (bounce type). Received/replied update `last_seen_at`. Metrics `emails_received`, `emails_replied`,
  `emails_sent`, `last_email_at`, `email_bounced`, `email_complained`.
- Visibility: `analytics_events` / `analytics_event` hide email events of mailboxes the viewer can't read
  (`readableMailboxes`). The person timeline leaves email events out (it already shows the mail itself).
- No subject or body is stored. Contacts get no email events (they're per-member address-book entries).
- Checked locally: sending from a test mailbox to an identified test person produced `$email_sent` through the
  real queue, and it shows under the Email tab. The received path is unit-tested (`counterparts`) but wasn't run
  end to end locally (needs inbound mail).

## 15. Phase 4 as built (2026-11-18)

- `audience/funnels.ts`: step and funnel schemas (2–10 steps; page path with `*` → GLOB with `[ ] ?` escaped;
  track event name; email `$email_*`), window 1–90 days (default 7), ranges 7/30/90. `funnelQuery` compiles to
  chained CTEs (s0 = first matching event per person in range, scoped by domain; sN = first match at or after
  s(N-1) and within s0 + window) and returns one row per person with the time of each step; `summarize` counts,
  drop-offs and median gaps in JS. Steps use `>=` on time, so events with the same timestamp still chain.
- Store: `funnels` and `funnel_cache` tables (in SCHEMA), `listFunnels` (each with its 30-day conversion),
  `getFunnel`, `saveFunnel` (max 50), `deleteFunnel`, `computeFunnel` (cache 5 min per range + domain, cleared on
  edit), `funnelOptions` (your event names, top 100 paths in 30 days).
- Operations (`mcp: false`): `analytics_funnels`, `analytics_funnel_result`, `analytics_funnel_options`,
  `analytics_create_funnel`, `analytics_update_funnel`, `analytics_delete_funnel` (changes need audience.manage).
- App: Funnels in the side list with their 30-day %, New funnel (+ in the header too), `Funnels.tsx` (view: overall
  conversion, bars, step table, range select, Edit, Delete; dialog: name, typed steps with suggestions, window).
  URL `#/analytics?funnel=<id>&range=7|30|90`. Icon `funnel`.
- Tests: `audience/funnels.test.ts` runs the SQL on node:sqlite (order, window, site, range, medians, validation).
- Checked in the browser: built "Checkout" (Viewed /products/* → Added to Cart → Order Completed) from seeded
  visitors (7 → 5 → 2, 28.6%), range change, edit (rename + window), delete. Narrow widths hide Dropped first.
- Limits to watch: results load one row per person who did step 1 into the Durable Object; fine into the hundreds
  of thousands. Not built: "create a segment from people who dropped off" (a natural next step).

## 16. Phase 5 as built (2026-11-18)

- Segments: new condition `{ kind: 'metric', key, op, value }` (api `audience/types.ts` METRICS: 30 keys with
  types), compiled like attributes but on `p.metrics`. The `audience_count` MCP description lists the keys.
- CSV export: metric columns after the fixed ones, except the email counts (they'd show mail in mailboxes the
  viewer can't read).
- App `users/metrics.ts`: labels and groups, `countryName` (Intl.DisplayNames), `profileSections`.
  - PersonPanel: Acquisition (first channel, campaign, referrer, landing page; latest only when different),
    Location & device, Activity (visits, page views, days active, time on site, last page/event, revenue, orders,
    when identified). Email counts aren't shown there (the timeline shows the mail itself).
  - Users table: Source shows the first channel when known (the raw source in the tooltip); new Country column.
  - Segment builder: Acquisition, Location & device, Activity (with "did event"), Email groups; hints for
    country codes and paths; channel suggestions.
- Checked in the browser: profile sections, table columns, a "First channel is Paid social" segment count, and
  counts by country, orders, revenue and emails through the API; unknown metric keys are rejected.
- Not done: the mobile app's person screen doesn't show metrics yet (phase 7 with the mobile Analytics screen).

## 17. Phase 7 as built (2026-11-18)

- MCP (`contacts.read`, read-only): `analytics_events`, `analytics_event`, `analytics_funnels`,
  `analytics_funnel_result`. Test event, settings and funnel changes stay off MCP. `apps/web/content/docs/mcp.md`
  regenerated (`pnpm --filter @xstate/api docs:mcp`). Email events still follow the actor's readable mailboxes
  (`readableMailboxes` honours `actor.mailboxIds`).
- Mobile (`apps/mobile`, JS only, ships with `eas update`): drawer entry **Analytics** (`ChartLine`),
  `sections/Analytics.tsx` (tabs Live events / Funnels; type chips; refetch every 4 s while in front; empty state
  points to the web app), `app/(app)/event/[id].tsx` (properties + visit), `app/(app)/funnel/[id].tsx` (7/30/90
  days, bars, from previous, dropped, median), person screen gets Acquisition / Location & device / Activity
  (`lib/analytics.ts` `profileSections`). Domain picked in the drawer scopes events and funnels.
- Checked: API tests, MCP doc check, mobile `tsc` and `expo lint`. **Not run on a device or simulator** (local iOS
  builds fail on this Mac's Xcode; needs an EAS preview update to try on the phone).

## 18. Phase 6 as built (2026-11-18): Overview

From the Claude Design "xstate App" → Analytics → Overview (after the five design fixes were checked).

- Decisions: visits (sessions) kept **180 days** so 90 days compare with the 90 before; their IP is cleared after
  90 days; events stay 90 days. Referrers show **letter avatars only** (no favicon service). Revenue lives on the
  visit (`sessions.revenue/orders`, upgrade 4 with backfill); a server order with no visit counts on the person's
  latest visit within 30 days before it.
- `audience/overview.ts`: ranges today/7/30/90 in the viewer's time zone (`tzOffset`), previous period of the same
  length, SQL for totals, series (day/hour buckets), breakdowns (13 dimensions; composite keys
  `source|medium|campaign`, `region|country`, `city|country`), filters (session columns, or "viewed page" / "did
  event" via EXISTS). Bounce = ≤1 page view and under 10 s; duration = max(first→last, time on pages).
- Store `trafficOverview` / `trafficBreakdown` (cached 60 s in memory), live = distinct people with events in 5 min.
- Operations `analytics_overview`, `analytics_breakdown` (also MCP, contacts.read, read-only).
- App `analytics/Overview.tsx` (+ `world-map.json`: 174 country outlines pre-projected from world-atlas 110m with
  Natural Earth projection, 39 KB gzipped, lazy-loaded), styles in `analytics.css` (container queries on the
  Overview's own width). Overview is the Analytics landing page; Live events moved to `?view=live`. URL keeps
  `period` and `filters`.
- Tests: `audience/overview.test.ts` on node:sqlite. Checked in the browser with seeded visits: tiles, chart and
  tooltip ("so far"), every card, map shading, filter chips (URL), filtered-card note, View all (tabs, sorting,
  Escape returns focus), empty state for a domain with no visits, no console errors. Conversions add up to the
  Revenue tile.
- Follow-up suggested: Analytics' domain switcher only lists mail domains; a tracked site on another domain shows
  only under All domains.
