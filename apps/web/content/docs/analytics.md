---
title: Add analytics to your site
description: Track page views, events and visitors on your website or app, and see where they came from.
---

xstate can record who visits your website or uses your app and what they do there. Add one snippet and every page
view is recorded with where the visitor came from, their device and their rough location. Call `identify` when
someone signs in and `track` for the things that matter to you, like a sign-up or an order.

Events show up in **Analytics** as they arrive. Visitors show up in **Users**: anonymous visitors as leads, and as
users once you identify them. Each person shows their timeline of page views and events, and you can build segments
from them.

## Install the snippet

Open **Analytics** in xstate: until the first event arrives it shows the snippet with your **publishable key**
already filled in (it's also in **Settings → API keys → Organization keys**). Paste it before the closing `</head>`
tag on every page:

```html
<script>
  window.xstate = window.xstate || function () { (xstate.q = xstate.q || []).push(arguments) }
  xstate('init', 'pk_live_your_publishable_key')
</script>
<script async src="https://api.xstate.com/js/xstate.js"></script>
```

That's all a basic install needs. Page views are recorded on load, and on every route change in single-page apps
(React, Vue, Next.js and the like), with no extra code.

The publishable key is safe to put in a web page. It can only add visitors and events, never read them.

### Install with an AI agent

**Analytics** also has a **Copy prompt** button. Paste the prompt into Claude Code, Cursor or another coding agent.
It first reads your whole codebase and writes an event dictionary: the events and properties worth tracking, where
each call goes, and which event carries revenue. It stops for you to review the dictionary, and only then adds the
snippet, `identify` on sign-in, `reset` on sign-out, and the `track` calls from the browser and your server.

### Check it works

Keep **Analytics** open and visit your site in another window. Your page view shows up within a few seconds, and
the page switches to **Live events**. Click an event to see everything recorded with it. To try the feed before the
snippet is on your site, click **Send test event**: it sends a "Test Event" from a test visitor.

If your visit doesn't show up:

- Make sure ad blockers and "Do Not Track" are off in that browser (see [Privacy](#privacy)).
- Check the browser console for errors loading `xstate.js`.
- The site has to be served over `http://` or `https://`, not opened as a file.

## Identify people

When someone signs in or signs up, tell xstate who they are. Everything they did before as an anonymous visitor is
kept and moves to their profile.

```js
xstate('identify', user.id, { email: user.email, name: user.name, plan: 'pro' }, userHash)
```

- `user.id` is your own id for the user. It must not change.
- The second argument is any facts about them. `email`, `name` and `phone` fill in the profile; anything else is
  saved as an attribute you can filter segments by. Values can be text, numbers or true/false.
- `userHash` proves the id really came from your server, so nobody can pretend to be one of your users from the
  browser console. Without a valid hash, the id is ignored.

Make the hash on your server, with your **secret key**, and pass it to the page:

```js
// Node.js
import { createHmac } from 'node:crypto'
const userHash = createHmac('sha256', process.env.XSTATE_SECRET_KEY).update(String(user.id)).digest('hex')
```

```python
# Python
import hmac, hashlib, os
user_hash = hmac.new(os.environ["XSTATE_SECRET_KEY"].encode(), str(user.id).encode(), hashlib.sha256).hexdigest()
```

Never put the secret key in a web page or app.

### Leads from a form

For a visitor who isn't a user yet, like someone who fills in a newsletter or contact form, leave the id empty. No
hash is needed:

```js
xstate('identify', null, { email: 'sam@example.com', name: 'Sam' })
```

### Signing out

When a user signs out, call `reset` so the next person on that browser starts as a new visitor:

```js
xstate('reset')
```

## Track events

Record anything people do with `track`, a name and optional properties:

```js
xstate('track', 'Signed Up', { method: 'email', plan: 'free' })
xstate('track', 'Added to Cart', { product: 'Linen Shirt', price: 48, quantity: 1 })
```

Use the same name every time for the same action. Names are case-sensitive and up to 100 characters. Properties
can be up to 4 KB of JSON.

### Revenue

Add a `revenue` number (and a `currency` code) to any event that earns money. xstate adds it up for each person, so
you can see their total revenue and number of orders, and build segments like "spent more than 100":

```js
xstate('track', 'Order Completed', { order_id: '4661', revenue: 96, currency: 'USD' })
```

## What's recorded automatically

You don't need any code for these.

| What | Details |
| --- | --- |
| Page views | Path, title, query string, on load and on every route change |
| Visits | A visit (session) ends after 30 minutes without activity, or when the visitor comes back from a different campaign or site |
| Campaigns | `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` and `utm_content` from the landing page's address |
| Ad clicks | Google (`gclid`, `gbraid`, `wbraid`), Microsoft (`msclkid`), Meta (`fbclid`), TikTok (`ttclid`), LinkedIn (`li_fat_id`) and X (`twclid`) click ids |
| Referrer | The site the visitor came from |
| Channel | Each visit is sorted into Direct, Organic search, Paid search, Social, Paid social, Email, Referral, Affiliate, Display, AI assistant or Other |
| Location | Country, region, city and time zone, worked out from the visitor's IP address |
| Network | The visitor's internet provider or company network |
| Device | Browser, operating system, desktop / mobile / tablet, screen and window size, language |
| Engagement | Time spent on each page and how far down it was scrolled |
| Outbound links | Clicks on links to other sites, as `$outbound_click` |

For each person, xstate also keeps:

- **First and last touch:** the channel, campaign, referrer and landing page of their first visit and of their
  latest one.
- **Location and device** from their latest visit.
- **Activity:** visits, page views, events, days active and total time on site.
- **Revenue:** total revenue, number of orders and the date of the first one.
- **When they were identified**, and how many days after their first visit.

Bots, crawlers, link previews and automated browsers are left out.

These show on each person's profile in **Users** (Acquisition, Location & device, Activity), the Users list shows
each person's first channel and country, and the CSV export includes them. You can build segments from them too:
in **New segment**, pick a field under Acquisition, Location & device, Activity or Email, like "First channel is
Paid search", "Country is US" or "Revenue more than 100".

## Email activity

Mail between your xstate mailboxes and people already in your audience is recorded too, with no code. It shows in
**Analytics** under **Email**, and counts on each person (emails received, sent and replied, last email):

| Event | When |
| --- | --- |
| `$email_received` | Someone in your audience emails one of your mailboxes |
| `$email_replied` | That email is a reply in a conversation |
| `$email_sent` | One of your mailboxes (a member, an agent or the email API) emails them |
| `$email_bounced` | Mail to them bounced |
| `$email_complained` | They marked your mail as spam |

- Only people already in your audience get email events: matched by their email address, on any of your sites.
  Mail from or to anyone else adds no one.
- Events say which mailbox it was, never the subject or the message. Members only see the email events of
  mailboxes they can read.
- Mail in Junk, mail with a virus, and mail copied in by an import aren't recorded.

## Overview

**Analytics → Overview** sums up your traffic for today or the last 7, 30 or 90 days:

- **Visitors, visits, page views, bounce rate, average visit length and revenue**, each with the change from the
  period before (turn **Compare to previous period** off to hide it) and a small trend line.
- **Visitors and visits** per day (per hour for today), with the period before as a dashed line.
- **Top lists**: sources (channels, referring sites, campaigns), pages (top, landing and exit pages), locations
  (a map, countries, regions, cities), devices, browsers and systems, your events, and revenue by channel or campaign.

Click any row, or a country on the map, to filter the whole page to it: for example "Channel is Paid search" and
then "Country is Germany". **View all** shows the full list, sorted however you like. A visit counts as a bounce when
it has one page view and lasts under 10 seconds.

Revenue counts on the visit it happened in. An order sent from your server counts on that person's latest visit in
the 30 days before, so it's credited to the channel that brought them.

## Funnels

A funnel shows how many people take a series of steps in order, and where they drop off: for example viewing a
product, adding it to the cart and completing the order. Create one in **Analytics → New funnel**:

- **Steps** (2 to 10), each one of:
  - **Page**: a page path, like `/pricing`. End it in `*` to match a whole section: `/products/*`.
  - **Track**: one of your events, like `Added to Cart`.
  - **Email**: email received, replied, sent, bounced or marked as spam (see [Email activity](#email-activity)).
- **Conversion window**: how long people have, from the first step, to finish (1 to 90 days, 7 by default).

For the last 7, 30 or 90 days, the funnel shows how many people reached each step, the share who went on from the
step before, how many dropped off, and the median time between steps. Steps count in order: an event before the
step it follows doesn't count. Anonymous visitors count too, and someone you identify later keeps their earlier
steps. Results are worked out again every few minutes.

Owners, admins and members who manage users can create, change and delete funnels; everyone can see them.

## On your phone and in AI apps

- The **xstate mobile app** has an Analytics section: live events (refreshed every few seconds) and your funnels,
  with each event's visit details and each person's acquisition, location and activity. Installing, settings and
  editing funnels stay on the web.
- **Connected AI apps** (see [Connect AI apps](/docs/mcp)) with access to contacts can read events
  (`analytics_events`, `analytics_event`) and funnels (`analytics_funnels`, `analytics_funnel_result`), so you can ask
  things like "where did this week's sign-ups come from?". Email events follow the same rule as in the app: only
  for mailboxes the connection can read.

## Options

Pass options as a third argument to `init`:

```js
xstate('init', 'pk_live_your_publishable_key', { autocapture: false })
```

| Option | Default | What it does |
| --- | --- | --- |
| `autocapture` | `true` | Set to `false` to stop recording clicks on outbound links |
| `respectDoNotTrack` | `true` | Set to `false` to record visitors whose browser sends Do Not Track or Global Privacy Control |
| `cookie` | `true` | Set to `false` to keep the visitor id in local storage only. Visitors are then counted separately on each subdomain |

### Your site and your app on different subdomains

If your marketing site is on `example.com` and your app on `app.example.com`, put the snippet on both with the same
key. A visitor who reads your pricing page and then signs up in the app is one person with one visit, so the
sign-up is credited to the ad, campaign or site that brought them. This works for any subdomain of a domain you
have verified in xstate; the dashboard shows them together under that domain.

To record a page view yourself, for example after a change the address bar doesn't show, call `xstate('page')`.

## From your server

You can send the same calls from your server with the **secret key**. Use this for things that happen away from the
browser, like a payment webhook or a subscription renewing.

```bash
curl https://api.xstate.com/v1/collect \
  -H "Authorization: Bearer sk_live_your_secret_key" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {
        "type": "track",
        "event": "Subscription Renewed",
        "userId": "usr_5tz1",
        "domain": "example.com",
        "properties": { "plan": "pro", "revenue": 12, "currency": "USD" }
      }
    ]
  }'
```

Each event needs:

- `type`: `track`, `identify` or `page`.
- `domain` (or a `url`): which of your sites it belongs to.
- Who it's about: `userId` (no hash needed with the secret key), or `email`, or the visitor's `anonymousId`.

Up to 50 events per request. `timestamp` (ISO 8601) is optional; times more than a week old are replaced with now.

A server has no browser, so xstate can't see the visitor's device or campaign. If you know them, send a `context`:

```json
{
  "type": "track",
  "event": "Signed Up",
  "userId": "usr_5tz1",
  "domain": "example.com",
  "context": {
    "userAgent": "Mozilla/5.0 …",
    "ip": "203.0.113.39",
    "locale": "en-US",
    "campaign": { "source": "google", "medium": "cpc", "name": "fall" },
    "referrer": "https://www.google.com/",
    "page": { "path": "/signup" }
  }
}
```

Location isn't worked out from a `context.ip`; it's only kept as given.

Names starting with `$pageview`, `$identify` and `$email_` are recorded by xstate itself and can't be sent.

## Limits

- 300 events a minute from each visitor (by IP address). Server calls with the secret key aren't limited this way.
- 64 KB per request, 50 events per request, 4 KB of properties per event.
- Events are kept for 90 days, and visits (for the Overview) for 180 days, so 90 days can be compared with the
  90 before.
- Anonymous visitors who never give an email or phone number are deleted after 30 days without a visit.
- Up to 100 attributes per person.

## Privacy

You decide what to record about your visitors, and you are responsible for telling them, for example in your
privacy policy and cookie notice. xstate processes this data on your behalf.

- The snippet stores a random visitor id and the current visit in a first-party cookie on your domain
  (`xstate_aid` and `xstate_sid`, kept for a year) and in the browser's local storage. The cookie lets your site and
  its subdomains share one visitor. It holds nothing but those two random ids. Set
  `cookie: false` to use local storage only.
- Nothing is sent when the visitor's browser asks not to be tracked (Do Not Track or Global Privacy Control),
  unless you set `respectDoNotTrack: false`.
- IP addresses are kept with each visit for 90 days, then removed from it. To stop keeping them, turn off **Keep IP addresses** in
  **Analytics → Install code** (owners, admins and members who manage users). The ones already kept are removed,
  and only the country, region and city are kept from then on.
- Locations are kept to the city: the coordinates are rounded to about 10 km.
- You can delete a person from **Users** at any time, which deletes their events and visits too.
