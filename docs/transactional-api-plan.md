# Plan: transactional email API and personal tokens

Status: all five phases built on 2026-11-16 and tested against the local mail stack; nothing is committed or
deployed. Migrations `0032_api_tokens.sql` and `0033_api_emails.sql` are applied to the local database only.
What was built differs from the text below in a few places, listed in [As built](#as-built). Decisions marked
**(decided)** were made by the owner on 2026-11-16; the ones marked **(proposed)** were built as written.

## Why

A developer has no way to send mail from their own server today. `POST /email/mailboxes/:mailboxId/send` only takes
a signed-in person's session JWT, which lasts 7 days and has no refresh. The organization Secret Key only works on
`POST /v1/collect`. MCP connections are OAuth and made for AI apps.

The goal: one mailbox serves both ways of working. People read and write mail in it as now, and a server can send
from the same address (receipts, alerts, password resets, CRM mail), with replies landing in that mailbox's inbox.

What already exists and is reused, not written again:

- the `email_send` operation and `mailserver.sendMessage` (`apps/api/src/operations/email.ts`)
- `Actor = { userId, mailboxIds }`, the shape agents and MCP connections already use to act as a person limited to
  some mailboxes (`auth/types.ts`, `auth/scope.ts`, `mailserver/access.ts`)
- caps and suspension (`mailserver/sending.ts`: `reserveSend`, `sending_suspensions`)
- the suppression list and the SES webhook (`jobs/ses-webhook.ts`)

## Decisions

1. **Send from any mailbox the token's owner can write to (decided).** Personal, shared and agent mailboxes alike.
   The rule is the existing write check (`mailContext(..., 'write')`): a personal mailbox only by its owner, a shared
   one by members with full access.
2. **Personal tokens, not the organization Secret Key (decided).** A token belongs to one person in one
   organization and acts as them. The Secret Key belongs to no person, so the write check would have nothing to
   check, and it also signs audience `userHash` values: rolling it after a leak would break `identify()` on every
   customer site.
3. **A token is shown once and stored as a hash (decided).** SHA-256 of the token plus its last 4 characters. No
   encrypted copy: nothing ever needs the original back, so a database leak exposes nothing usable.
4. **Tokens live in D1 (decided).** KV was considered and turned down: a revoke could take up to a minute to reach
   every location, there is no way to list a person's or an organization's tokens without hand-kept index keys, and
   nothing cascades when a mailbox or member is removed. KV can be added later as a 30–60 second cache in front of
   D1 if lookups ever show up in latency.
5. **`saveToSent` flag per request, default false (decided).** True saves the message to the mailbox's Sent folder
   exactly like a normal send. False leaves the mailbox untouched; the message only appears in the send log.
6. **Same caps as mail sent by hand (decided).** API sends go through `reserveSend` with the same counters: per
   mailbox 100 outside recipients an hour and 500 a day, per organization 400 an hour and 2,000 a day. Raising caps
   per plan belongs to `docs/pricing-plan.md`.
7. **Bounces and complaints suspend the mailbox (decided).** API mail counts in the same 7-day window as the
   mailbox's other mail. Crossing `SUSPEND` blocks the mailbox's sending everywhere (API, app, SMTP); the
   organization rule applies as now. No token-level suspension and no separate SES configuration set.
8. **A token with no usable mailbox stops working (decided).** Access is checked live on every request. Details in
   [When a token stops working](#when-a-token-stops-working).
9. **No open or click tracking (decided).** Delivery status only (sent, delivered, bounced, complained), from the
   SES webhook that already runs.
10. **Settings → API keys gets two tabs (decided):** Organization Keys and Personal Tokens.
11. **Scopes on tokens, one for now (proposed).** `mail.send`, the same name the MCP tools use. A later API becomes
    a new scope, not a new kind of key.
12. **Sending is synchronous (proposed).** `201` means SES accepted the message, as with `email_send` today. No
    queue and no `scheduledAt` in v1.

## Personal tokens

Format: `xst_live_` + 40 characters from the alphabet in `audience/keys.ts` (`randomToken`). The fixed prefix lets
secret scanners and our own logs recognise a leaked token.

```sql
CREATE TABLE api_tokens (
  id               TEXT PRIMARY KEY,          -- tok_…
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,             -- "Billing server"
  token_hash       TEXT NOT NULL UNIQUE,      -- hex SHA-256
  last4            TEXT NOT NULL,
  scopes           TEXT NOT NULL,             -- JSON: ["mail.send"]
  expires_at       TEXT,                      -- NULL = no expiry
  last_used_at     TEXT,
  revoked_at       TEXT,
  revoked_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX api_tokens_user_idx ON api_tokens (organization_id, user_id);

CREATE TABLE api_token_mailboxes (
  token_id    TEXT NOT NULL REFERENCES api_tokens (id) ON DELETE CASCADE,
  mailbox_id  TEXT NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
  PRIMARY KEY (token_id, mailbox_id)
);
```

### Checking a request

A new `requireToken` middleware, on `/v1/emails*` only. Session routes do not accept tokens and token routes do not
accept sessions.

1. Read `Authorization: Bearer xst_live_…`, hash it, look the row up by `token_hash`.
2. Refuse (`401 invalid_token`) if there is no row, or it is revoked or past `expires_at`.
3. Refuse if the owner is no longer a member of the organization, or the organization has API tokens turned off.
4. Build `Actor = { userId, mailboxIds }` from the token's mailboxes and run the operation. The existing write
   check then decides, so access removed in the app takes effect on the next request.
5. Update `last_used_at` at most once a minute, in `waitUntil`.

Failed lookups are rate limited per IP with a Workers rate limiter, as sign-in is.

### Managing tokens

Operations (HTTP only, `mcp: false`, session auth, so a token or an agent can never make or change tokens):

| Operation | HTTP | Who |
| --- | --- | --- |
| `tokens_list` | `GET /orgs/:organizationId/tokens?all` | Your own; owners and admins may pass `all` for everyone's |
| `tokens_create` | `POST /orgs/:organizationId/tokens` | Any member. Body: `name`, `mailboxIds`, `expiresIn` (30d, 90d, 1y, none). Returns the token once. |
| `tokens_update` | `PATCH /orgs/:organizationId/tokens/:tokenId` | The owner: `name`, `mailboxIds` |
| `tokens_revoke` | `DELETE /orgs/:organizationId/tokens/:tokenId` | The owner, or any owner or admin |

- At most 20 active tokens per person per organization.
- `mailboxIds` on create and update must each pass the write check at that moment.
- No "roll" button: rotating is create a new one, switch over, revoke the old one.
- An email goes to the person when a token is created on their account, and a week before one expires. There is
  no audit log yet (`security-gaps`), so this is how a token made from a hijacked session gets noticed.
- An organization setting, for owners and admins, turns API tokens off for everyone.

### When a token stops working

| What happened | Result |
| --- | --- |
| Lost write access to some of its mailboxes | Keeps working for the rest; sending from a lost one is `403 from_not_allowed` |
| Lost write access to all of them | Every call is `403 no_mailboxes`; listed as "Inactive: no mailboxes" |
| Access comes back | Works again without being recreated (proposed) |
| A mailbox is deleted | Removed from the token for good (foreign key) |
| The owner leaves the organization | Revoked for good; owners and admins get an email (proposed) |
| Revoked or expired | `401 invalid_token` from the next request on |

## API

Host: `https://api.xstate.com`. Errors use the existing shape `{ error: { code, message, details? } }`.

### `POST /v1/emails`

Optional header `Idempotency-Key` (max 255 characters), remembered for 24 hours. The same key with the same body
returns the first response again with `Idempotent-Replay: true`; with a different body it is `409`.

```ts
{
  from: string | { email: string; name?: string }  // primary address or alias of a mailbox the token covers
  to: Address[]                  // 1–50; Address = string | { email, name? }
  cc?: Address[]
  bcc?: Address[]                // to + cc + bcc ≤ 50 in total
  replyTo?: Address[]            // max 5
  subject: string                // max 998
  text?: string                  // max 1 MB; at least one of text or html
  html?: string                  // max 2 MB; text is made from html when left out
  attachments?: {
    name: string                 // max 255
    type: string                 // MIME type
    content: string              // base64
    contentId?: string           // inline images (cid:)
  }[]                            // max 20, 25 MB in total
  headers?: Record<string, string>   // only X-* and List-Unsubscribe(-Post)
  tags?: Record<string, string>      // max 10; kept in the send log, not sent
  saveToSent?: boolean           // default false
}
```

```ts
// 201
{
  id: "em_…",
  status: "sent",
  from: { email, name },
  subject: string,
  recipients: [{ email, type: "to" | "cc" | "bcc", status: "sent" | "suppressed" }],
  savedToSent: boolean,
  tags: {},
  createdAt: string
}
```

- Suppressed recipients are skipped and marked; the call only fails when all of them are suppressed.
- If `saveToSent` is true and the copy can't be saved, the email still goes out and `savedToSent` is false.
- Attachments go through the same file safety rules as attachments uploaded in the app.

### `GET /v1/emails/:id`

The same shape, with `status` and each recipient's `status` (`sent`, `delivered`, `bounced`, `complained`,
`suppressed`), `detail` (the bounce reason) and `updatedAt`, filled in by the SES webhook. The message-level status
is `partial` when recipients differ. Bodies and attachments are not stored or returned.

### `GET /v1/emails`

`?limit=1..100` (default 25), `cursor`, `status`, `from`, `tag.<key>=<value>`. Returns `{ emails, nextCursor }`.
Lists what the token's owner sent through the API from mailboxes they can still write to.

### Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_input` | The body fails validation |
| 401 | `invalid_token` | Missing, unknown, revoked or expired |
| 403 | `from_not_allowed` | `from` isn't an address of a mailbox the token covers and its owner can write to |
| 403 | `no_mailboxes` | The token has no usable mailbox left |
| 403 | `sending_suspended` | The mailbox or organization is suspended for bounces or complaints |
| 403 | `api_tokens_disabled` | An owner or admin turned API tokens off |
| 409 | `idempotency_conflict` | The same `Idempotency-Key` with a different body |
| 413 | `attachments_too_large` | More than 25 MB of attachments |
| 422 | `all_recipients_suppressed` | Every recipient is on the suppression list |
| 429 | `send_limit_reached` | A cap was hit; `details.retryAfter` in seconds |

### Storage for the send log

```sql
CREATE TABLE api_emails (
  id               TEXT PRIMARY KEY,          -- em_…
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mailbox_id       TEXT REFERENCES mailboxes (id) ON DELETE SET NULL,
  token_id         TEXT REFERENCES api_tokens (id) ON DELETE SET NULL,
  user_id          TEXT REFERENCES users (id) ON DELETE SET NULL,
  from_email       TEXT NOT NULL,
  from_name        TEXT,
  subject          TEXT NOT NULL,
  tags             TEXT NOT NULL DEFAULT '{}',
  saved_to_sent    INTEGER NOT NULL DEFAULT 0,
  message_id       TEXT,                      -- the Message-ID header, to match SES events
  idempotency_key  TEXT,
  request_hash     TEXT,                      -- to tell a replay from a conflict
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX api_emails_idem_idx ON api_emails (token_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX api_emails_org_idx ON api_emails (organization_id, created_at);

CREATE TABLE api_email_recipients (
  email_id    TEXT NOT NULL REFERENCES api_emails (id) ON DELETE CASCADE,
  address     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('to', 'cc', 'bcc')),
  status      TEXT NOT NULL,
  detail      TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (email_id, address)
);
```

Rows are kept 30 days and purged by the hourly cron (proposed). Idempotency keys are honoured for 24 hours.

## How a send runs

1. `requireToken` builds the actor.
2. Find the mailbox that owns `from` (primary address or alias) and check it is in the token's mailboxes and the
   owner can write to it.
3. Idempotency: an existing row for this token and key is returned (same `request_hash`) or refused.
4. Upload the base64 attachments as blobs to the mailbox's Stalwart account, as `http/uploads.ts` does.
5. Call `mailserver.sendMessage` with a new option for "no Sent copy". With `saveToSent` it runs as today. This
   keeps suppression, `reserveSend`, DKIM and the SES path identical for both ways of sending.
6. Write `api_emails` and its recipients; return `201`.
7. Later, `ses-webhook` matches the event to `api_email_recipients` by Message-ID and recipient and updates the
   status, next to the suppression and suspension work it already does.

To check before building: how a message is submitted without leaving a copy in Sent (create in Drafts, submit with
`onSuccessDestroyEmail`), and that custom `replyTo` and `headers` pass through `sendMessage`.

## Settings → API keys

- **Organization Keys** tab: the page as it is today (publishable key, secret key, install snippet). Owners and
  admins only. The secret key's line drops "and sending": sending goes through personal tokens.
- **Personal Tokens** tab: every member. Your tokens with name, `xst_live_…last4`, mailboxes, last used, expiry
  and state; Create (name, mailboxes, expiry, then the token shown once with Copy) and Revoke.
- Owners and admins also get an "All members" list on that tab, to see and revoke anyone's token, and the switch
  that turns API tokens off.
- The page opens to all members; non-admins only see the Personal Tokens tab.
- Mobile: not in this plan.

## Public docs page

A new page `apps/web/content/docs/transactional-email.md` ("Send transactional email"), listed in
`content/docs/meta.json` after `mcp`. It is written and published in the same phase the endpoint goes live, so the
docs never describe something that doesn't work yet. Outline:

1. What it is for, and what it is not (receipts, alerts, resets; not newsletters or bulk mail).
2. Create a token: Settings → API keys → Personal Tokens, choosing mailboxes, the token is shown once.
3. Send your first email: a `curl` example, then Node and Python `fetch` examples.
4. Request fields and the response, as tables.
5. Showing the message in Sent (`saveToSent`) and where replies go.
6. Safe retries with `Idempotency-Key`.
7. Checking delivery: `GET /v1/emails/:id` and what each status means.
8. Limits, and what happens after bounces and complaints (shared with the mailbox's normal mail).
9. Errors, as a table with what to do about each.
10. Keeping tokens safe: server side only, expiry, revoking, what happens when access is lost.

Also updated in that phase: `quickstart.md` (a link), and `security.md` (how tokens are stored and checked, who can
revoke them, the switch for admins).

## Phases

Each phase ends with something that works and can be shipped on its own.

1. **Tokens.** Migration (`api_tokens`, `api_token_mailboxes`), `auth/api-tokens.ts`, `requireToken`, the four
   `tokens_*` operations, the emails for created and expiring tokens, tests. Nothing uses a token yet.
2. **Settings.** The two tabs, create and revoke, the admin list and switch.
3. **Sending.** Migration (`api_emails`, `api_email_recipients`), `POST /v1/emails` with idempotency and
   `saveToSent`, `GET /v1/emails/:id`, `GET /v1/emails`, the "no Sent copy" path in `sendMessage`, tests against
   the local mail stack (`pnpm mail:dev`, `SES_MODE=fake`).
4. **Status.** `ses-webhook` updates recipient statuses; the suspension email names the token behind the bounced
   mail; the purge of old log rows.
5. **Docs.** The public page above, `quickstart.md`, `security.md`.

## As built

Where the code differs from the plan above:

- **Ids.** Token ids are plain UUIDs like every other table, not `tok_…`. Message ids are `em_` + 24 characters.
- **Managing tokens.** A fifth operation, `tokens_set_enabled` (`PUT /orgs/:organizationId/tokens/settings`), is
  the switch for owners and admins. `tokens_list` also returns `enabled`, `canManage`, the mailboxes the person can
  pick and the limit, so the page needs one call.
- **A `queued` status.** A message is logged before it is sent, so two retries at the same moment can't both send.
  Its recipients are `queued` until the mail server has it. A retry that arrives while the first request is still
  sending gets `409 request_in_progress`.
- **The overall status** is how far the slowest recipient has got (`queued`, `sent`, `delivered`); `partial` only
  when some recipients bounced or complained and others didn't.
- **Addresses on xstate** are marked `delivered` at once: the mail server delivers them itself and SES never
  reports on them.
- **`savedToSent`** repeats what the request asked for. The mail server moves the message to Sent as part of
  submitting it, so there is no separate step that could fail on its own.
- **Suppression.** If every address in `to` is suppressed the message is refused too, even when a `cc` remains.
- **`retryAfter`** is an upper bound: 3600 for an hourly cap, 86400 for a daily one.
- **Rate limits.** `EMAILS_RATE`: 300 requests a minute per token. `TOKEN_FAIL_RATE`: 20 wrong tokens a minute
  per IP.
- **Matching SES events.** Each message is sent with the Message-ID `<id>@<sender's domain>`. SES only echoes it
  when its notifications include the original headers, so without it the newest message from that sender to that
  address in the last 3 days is updated. To check in production: whether the SNS notifications carry
  `mail.commonHeaders`.
- **Suspension email.** New (`emails/notices.ts`): owners, admins and the mailbox's owner are told when sending is
  suspended, with the tokens that sent from there in the last 7 days.
- **Not built:** a view of the send log in the app. It is only reachable through `GET /v1/emails`.

## Later

- Open and click tracking (turned down for now).
- Templates with variables, outbound webhooks for status, an SDK.
- IP allowlists per token; transferring a token to another member.
- More scopes, and accepting tokens on the MCP server for headless use (`docs/mcp-server-plan.md`, decision 4).
- Higher caps per plan (`docs/pricing-plan.md`).
