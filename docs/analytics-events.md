# xstate's own analytics: event dictionary

Status: **approved and implemented, 2026-11-19 (uncommitted).** Before it records anything in production, see §7.

This is what xstate records about its own users with xstate Analytics (the product's own snippet and
`POST /v1/collect`), so we can see where sign-ups come from, how far people get through onboarding, which features
they use, and what earns money.

## 1. Setup

| | |
| --- | --- |
| Publishable key | `pk_live_yu66CLbuyW9uTjnxwBdcVwRsSsZcojLd` (main organization, asif@xstate.com) |
| Secret key | `XSTATE_SECRET_KEY`, an optional Worker secret on the API. Never sent to a browser. Without it nothing is sent and `userHash` is null. |
| Site | `xstate.com`. The marketing site (xstate.com) and the app (go.xstate.com) count as one site because xstate.com is a verified domain of the main organization (`audience/site.ts`), and the snippet shares its visitor id across subdomains. |
| Snippet on | `apps/web/app/layout.tsx` (marketing site and docs), the go.xstate.com landing page `apps/app/public/index.html`, and every page of the app: `apps/app/src/app/index.html`, `login/`, `signup/`, `invite/`, `connect/`, `migrate/`, `reset/`. Not on `s/` (public shared files: those visitors aren't xstate users). |
| Hostnames | The snippet always defines `window.xstate` (so calls queue harmlessly) but only runs `init` and loads `xstate.js` on `xstate.com` and its subdomains. Local dev, previews and the desktop app send nothing from the browser. |
| Not covered by the snippet | The mobile app, the desktop app (it serves the app from `app://xstate/`), MCP, agents, the transactional API. Their actions are recorded by the server events below, with `via` saying where they came from. |

## 2. Conventions

- Event names: Title Case, object then past-tense verb (`Domain Verified`).
- Property names: snake_case.
- Every event carries `org_id`, the organization the action happened in.
- **Server by default.** An event is sent from the API when the API is where the action happens. That covers the
  web, mobile, desktop, MCP and agents alike, and ad blockers can't drop it. Server events use the same `userId` as
  `identify`, `domain: "xstate.com"`, and are sent in the background (`ctx.waitUntil`; queue jobs and agent runs
  await them off the request path). A failure is logged (`analytics: collect answered …`) and never breaks the
  action. Properties that need lookups are worked out in the background too.
- Browser events only for what exists only in the browser (opening checkout, finishing the onboarding screens).
- All names and properties live in one typed module per side: `apps/api/src/analytics/events.ts`
  (`ServerEvents`, `track(env, background, userId, organizationId, event, props)`, `userHash`) and
  `apps/app/src/lib/analytics.ts` (`BrowserEvents`, `identify`, `reset`, `track`).
- `via` comes from the operation context: HTTP calls send `X-Client: web | mobile | desktop` (the web app, the
  mobile app and the desktop app set it), MCP calls are `mcp`, agent runs `agent`, anything else `app`.
- Never in properties: message subjects or bodies, recipient addresses, file names, calendar titles, passwords,
  tokens or keys.

## 3. Identify and sign-out

`xstate('identify', user.id, { email, name, org_id, role, plan }, userHash)`

- When: every time the app loads `/auth/me` (`lib/account.ts` for the dashboard, `onboarding/main.tsx` for sign-up
  and onboarding, `migration/main.tsx`), so it also runs right after sign-up, sign-in and invite acceptance.
- `userHash`: hex HMAC-SHA256 of `String(user.id)` keyed with `XSTATE_SECRET_KEY`, made on the API. Returned as
  `userHash` by `GET /auth/me`, `POST /auth/register`, `/auth/login`, `/auth/password/change` and
  `/auth/invitations/accept` (when it signs in). Skipped when null.
- `user.id` is the `users.id` UUID. `plan` is `free`, `pro` or `team`.

`xstate('reset')` inside `signOut()` in `apps/app/src/lib/core.ts`, which every sign-out path uses (Settings,
onboarding, the connect page, an expired session).

## 4. Events

Server events are added in the operation (`apps/api/src/operations/*`) unless the table says otherwise, so actions
done by the system itself (a Google Workspace import creating mailboxes, say) aren't counted as people's actions.

### Sign-up and onboarding

| Event | Fires when | Where | Properties |
| --- | --- | --- | --- |
| Signed Up | A new account is created | Server: `operations/auth.ts` `authRegister`; `members/service.ts` `acceptInvite` when it creates the account | `source`: `signup` \| `invite`; `role`: `owner` \| `admin` \| `member` |
| Domain Added | A domain is added to the organization | Server: `operations/email.ts` `emailAddDomain` | `domain`: string; `is_first_domain`: boolean; `dns_provider`: string \| null (e.g. `cloudflare`) |
| Domain Verified | The domain first becomes verified (once: the update only applies to a pending domain) | Server: `mailserver/domains.ts` `verifyDomain` | `domain`; `hours_to_verify`: number (since added, one decimal) |
| Mailbox Created | A person creates a mailbox | Server: `operations/email.ts` `emailCreateMailbox` | `kind`: `personal` \| `shared` \| `agent`; `is_first_mailbox`: boolean |
| Alias Added | A person adds an alias to a mailbox | Server: `operations/email.ts` `emailAddAlias` | none beyond `org_id` |
| Onboarding Completed | The person leaves the last onboarding step (Continue or Skip), once per browser | Browser: `onboarding/AgentStep.tsx` | `domain_verified`: boolean; `agent_connected`: boolean |
| Member Invited | An invite email is sent (not invites created with `send: false`) | Server: `operations/members.ts` `membersInvite` | `role` |
| Invite Accepted | An invite is accepted | Server: `members/service.ts` `acceptInvite` | `role`; `new_account`: boolean |

### Activation and use

| Event | Fires when | Where | Properties |
| --- | --- | --- | --- |
| Email Sent | A person (or an agent or AI app acting for them) sends mail | Server: `operations/email.ts` `emailSend` (`recordSent`) | `via`: `web` \| `mobile` \| `desktop` \| `app` \| `mcp` \| `agent`; `is_reply`: boolean; `recipient_count`: number; `has_external_recipients`: boolean (any recipient not on one of the organization's domains); `has_attachments`: boolean |
| Migration Started | A Google Workspace import starts copying | Server: `migration/service.ts` `start` | `mailbox_count`: number (people not skipped); `includes`: string list (`mail`, `calendar`, `drive`, `contacts`) |
| Migration Completed | The import's first final pass finishes (the automatic second pass isn't counted) | Server: `migration/final.ts` `finishIfDone` | `mailbox_count`; `email_count`: number; `duration_hours`: number. `userId` is whoever started it. |
| AI App Connected | A person approves an MCP connection | Server: `mcp/consent.ts` `approveRequest` | `client_name`: string (e.g. `Claude`, `Cursor`); `scopes`: string list |
| Agent Created | An agent is created | Server: `operations/agents.ts` `agentsCreate` | `provider`: `anthropic` \| `openai` \| null (null until a model is picked, which is usual at creation) |
| API Token Created | A personal token for the transactional API is created | Server: `auth/api-tokens.ts` `createToken` | `mailbox_count`: number; `expires`: boolean |

Transactional API sends (`emails/service.ts` `sendEmail`) are not `Email Sent`: their volume would bury product
use. `API Token Created` marks adoption instead.

### Money

Money events are recorded for the organization's owner (`organizations.owner_id`).

| Event | Fires when | Where | Properties |
| --- | --- | --- | --- |
| Checkout Started | The provider's checkout page is requested | Browser: `settings/Billing.tsx` `upgrade`, before redirecting | `plan`: `growth`; `size`: number (Growth size in people) |
| Order Completed | A payment succeeds: the first one, renewals, and prorated size changes | Server: `billing/analytics.ts` `recordPayment`, from the provider's paid-payment webhook | **`revenue`**: number (total less tax, major units, e.g. 49); **`currency`**: `USD`; `plan`: `growth` \| `custom`; `size`: Growth size in people; `billing_reason`: `new` \| `renewal` \| `change` \| `other`; `transaction_id` |
| Plan Changed | The organization's plan or Growth size changes | Server: `billing/service.ts` `applySubscription` | `from_plan`; `to_plan`; `from_size`; `to_size`; `direction`: `upgrade` \| `downgrade` |
| Payment Failed | A payment attempt fails (the provider retries, so one failed renewal can send several) | Server: `billing/analytics.ts` `recordPayment` | `plan`; `size` |
| Order Refunded | A refund is made | Server: `billing/analytics.ts` `recordPayment`, from the provider's refund webhook | `refund_amount`: number (major units, before tax); `currency`; `transaction_id` (the refunded payment); `full_refund`: boolean |

`Order Completed` is the only event with `revenue`, so renewals count as real cash and nothing is counted twice.
$0 transactions are skipped. Provider amounts arrive in minor units and are converted. Each payment and each
refund is recorded once even when the provider delivers the webhook again: the first delivery claims a row in
`analytics_sent` (D1 migration 0044); without that table the event is skipped rather than risk a double count.
`Order Refunded` carries `refund_amount`, not `revenue`, so it never adds to revenue totals; net revenue is the
two subtracted.

`applySubscription` only writes over the state it read (compare-and-set, retried), so when the webhook and the
hourly refresh apply the same change at once, only one of them records it.

### Churn

| Event | Fires when | Where | Properties |
| --- | --- | --- | --- |
| Subscription Canceled | A paid subscription is canceled: once, when the cancellation is scheduled, or when it ends without having been scheduled | Server: `billing/service.ts` `applySubscription` | `plan`; `size`; `tenure_days`: number (since the subscription started); `immediate`: boolean |
| Member Removed | A person who had joined is removed or leaves (not a cancelled invite) | Server: `members/service.ts` `removeMember` | `role` of the removed member; `tenure_days`. `userId` is the person who removed them, never the removed person's details. |

When a scheduled cancellation takes effect, `Plan Changed` (to `free`, `downgrade`) follows.

## 5. Not tracked, on purpose

- Sign-in: `identify` and page views already show who is active and when.
- Reading, opening or searching mail, and anything with message content.
- Storage and Calendar actions: page views of `/storage` and `/calendar` are enough for now. Add events when there
  is a question they'd answer.
- Clicks on marketing-site buttons: page views and funnels (`/pricing` → `/signup` → `Signed Up`) cover them.
- Size changes: the prorated charge shows up as `Order Completed` with `billing_reason: change`.

## 6. Decisions on the review questions

1. Payment notifications: the provider's file (`billing/stripe.ts`, phase 2 of docs/billing-limits-plan.md) turns
   its payment and refund webhooks into neutral events for `recordPayment`. (Paddle was removed 2026-11-19.)
2. Web, mobile or desktop: yes, the clients send `X-Client`.
3. `/s/`: no snippet.
4. Onboarding Completed stays a browser event.
5. Development and preview send nothing.
6. `Organization Deleted` waits for organization deletion to be built.
7. The privacy policy and `security.md` now say xstate uses its own analytics.

## 7. Before it records in production

1. `wrangler secret put XSTATE_SECRET_KEY` on the API: the main organization's secret key (Analytics → Install code).
2. Apply D1 migration `0044_analytics_sent.sql` to production (`pnpm --filter @xstate/api db:migrate:remote`).
   Until then money events are skipped (logged), never double counted.
3. At the payment provider, send payment, failed-payment and refund events to
   `https://api.xstate.com/webhooks/billing/stripe` (set up in phase 2 of docs/billing-limits-plan.md).
4. The mobile app's `X-Client: mobile` header reaches phones with the next EAS update; until then mobile sends
   show as `via: app`.
5. Check Analytics → Live events after signing up on go.xstate.com.
