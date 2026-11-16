# Plan: xstate MCP server

Status: Phases 0–4 built and deployed to production 2026-11-16 (commit 8fbc720). `https://mcp.xstate.com/mcp` is
live; checked: discovery documents, `401` without a token, Claude's sign-in request redirected to the Connect page.
Connected from a real app on 2026-11-16 (the owner, in Claude Code): sign-in, consent and the tool list worked.
Cursor, Codex and ChatGPT not tried yet. Phase 5 (later) not started.

The MCP server lets the AI apps people already use (Claude, Claude Code, Codex, Cursor, ChatGPT) work with their
xstate mail, calendar, files and contacts. Onboarding step 5 and the marketing footer already promise it; today
`https://mcp.xstate.com/sse` (`apps/app/src/onboarding/state.ts`), `/docs/mcp` and `/.well-known/mcp.json` lead
nowhere.

What already exists: every API action is an operation (`apps/api/src/operations/`) with an `mcp` flag, a zod input
schema and a description written for agents. xstate's own agents already run operations as tools
(`agents/tools.ts`: `z.toJSONSchema(op.input)`, `op.run(ctx, input)`, mailbox scoping with `scopeInput`). The MCP
server is a second consumer of the same list. No email, storage or calendar logic is written again.

## Decisions (proposed)

1. **Runs in the existing API Worker**, served at `https://mcp.xstate.com/mcp` (a second custom domain on
   `xstate-api`; the fetch handler branches on hostname). The operations, D1, Durable Objects and access checks are
   all there. A separate Worker would import API source across apps, the same reason agents stayed in the API.
2. **Streamable HTTP, stateless, no SSE endpoint.** `createMcpHandler` from `agents/mcp/server` (already a
   dependency, `agents` 0.33.0) builds a fresh server per request and needs no Durable Object. The `/sse` URL in
   onboarding changes to `/mcp`. SSE as a separate transport is being dropped by clients; nobody has connected to
   the old URL, so there is nothing to keep working.
3. **OAuth sign-in, xstate as its own authorization server**, with `@cloudflare/workers-oauth-provider`
   (`OAuthAuthorizationServer` + `OAuthResourceServer`). This is what Claude, ChatGPT and Cursor expect from a
   remote server: the user pastes a URL, a browser opens, they approve. Client ID Metadata Documents on, dynamic
   client registration on for older clients. Session JWTs are not accepted on `mcp.xstate.com`.
4. **No API-key access in v1.** Headless use (CI, a server-side agent) waits for personal access tokens or the
   organization secret key, as a later phase. OAuth covers every client named in onboarding.
5. **One connection = one user in one organization.** The consent screen picks the organization; `organizationId`
   is then filled in on every call from the grant, never chosen by the model (the rule agents already follow).
6. **The user picks what the connection can do on the consent screen**, and tools outside that are not listed at
   all (the server is built per request from the grant, so `tools/list` only shows what was granted). See
   [Access](#access).
7. **Every call still runs the operation's own access checks as that user.** The grant can only narrow what the
   user can do, never widen it. A member removed from the organization loses MCP access on the next call without
   any revocation step.
8. **The onboarding step keeps the app picker and the snippet, and loses "Addresses" and "Access level".** Those
   choices can't bind a connection that doesn't exist yet (today they're only saved in the browser). They move to
   the consent screen, where they take effect.

## Access

The consent screen (a page in the app, `go.xstate.com/connect`) shows the app's name, then:

- **Organization** (when the user is in more than one).
- **Mailboxes** the app can use: the user's personal mailbox ticked, shared ones unticked.
- **Email**: Read only · Draft only (default) · Draft and send.
- **Calendar**, **Storage**, **Contacts**: Off · Read · Read and change. Default: Read.
- **Setup** (domains, mailboxes, aliases): off, and only offered to owners and admins.

These become scopes on the grant (`mail.read`, `mail.draft`, `mail.send`, `calendar.read`, `calendar.write`,
`storage.read`, `storage.write`, `contacts.read`, `contacts.write`, `setup`), plus `mailboxIds` and
`organizationId` in the grant's props. Each operation names its `scope` in its `mcp` field
(`operations/define.ts`); one without a scope doesn't compile.

Default "Draft only" matters: mail is text written by strangers, and an app reading it can be talked into acting
on it. Sending on its own is something the user turns on knowingly.

### Tool list

73 operations are MCP-enabled today. Changes:

| Change | Operations | Why |
|---|---|---|
| Turn off | `email_set_mailbox_password`, `email_grant_access`, `email_revoke_access` | Lock a person out, or open a mailbox to someone. Dashboard only. |
| Move behind `setup` | `email_*_domain*`, `email_get_dns_records`, `email_create_mailbox`, `email_update_mailbox`, `email_delete_mailbox`, `email_add_alias`, `email_remove_alias`, `email_list_access` | Admin work; 17 tools most connections never need. |
| Keep off | agents, AI keys, secrets, connectors, API keys, members changes, migration, devices, raw bytes, public links | As today. |
| Keep | the rest | Mail, calendar, storage, contacts, `members_list`, `auth_me`. |

A default connection (draft only, the rest read) lists about 30 tools, which keeps the app's context small.

Each tool carries `title`, `readOnlyHint` and `destructiveHint` from the operation, the JSON Schema of its input
without `organizationId`, and returns the operation's result as `structuredContent` plus the same JSON as text. An
`ApiError` becomes a tool error (`isError`) with its code and message, so the model can read why and correct
itself. Operations that return a `Response` (downloads) stay off MCP.

## How a call flows

1. The client calls `POST mcp.xstate.com/mcp`. Without a token it gets `401` pointing at the protected resource
   metadata, which names the authorization server.
2. The client opens `/authorize`. The API checks the request and redirects to `go.xstate.com/connect?...`.
3. The app (signed in, or after sign-in) shows the consent screen and posts the choices to the API with the
   user's session token. The API checks the user really is a member of that organization and can open those
   mailboxes, then calls `completeAuthorization({ userId, scope, props })` and returns where to send the browser.
4. The client swaps the code for tokens (PKCE). Grants and tokens live in a KV namespace (`OAUTH_KV`), managed by
   the library; props are encrypted.
5. On each call the resource server validates the token, the handler builds the server from the grant's scopes,
   and a tool call runs: fill in `organizationId`, then
   `op.run({ env, actor: { userId, mailboxIds }, waitUntil }, input)`. The mailbox limit is enforced where mail
   access is decided, not here.

## Safety

- **Rate limit:** `MCP_RATE`, 120 calls a minute per grant. `email_send` also stays under the organization's
  sending caps and suppression list, as for people and agents.
- **Log every tool call** (grant, client, user, organization, tool, ok or error code; never inputs or results) to
  Workers logs. This is the nearest thing to an audit trail until the audit log exists (security gaps list).
- **Revocation:** Settings → Connected apps lists the user's connections (app, organization, what it can do, last
  used) with Disconnect. Owners and admins see and can disconnect every connection in the organization.
- **Token life:** access tokens 1 hour, refresh tokens 30 days from last use.
- **Hostname and origin checks** on the handler (`allowedHostnames: ['mcp.xstate.com']`).
- `apps/web/content/docs/security.md` gets a section on connected apps.

## Phases

### 0. Spike (done 2026-11-16, code removed)

The spike was a second Worker config around the real API (`spike/index.ts` re-exporting `src/index.ts`) with the
authorization server, an `/authorize` that approved as a fixed test user, and the MCP resource at `/mcp`, all on
one local origin with its own throwaway D1 and KV state. A script using the MCP SDK's own client
(`@modelcontextprotocol/client` 2.4.0) ran the whole flow. Packages it brought in and Phase 1 keeps:
`@cloudflare/workers-oauth-provider` 1.2.4, `@modelcontextprotocol/server` 2.4.0.

#### Findings

- **Both OAuth roles run inside the API Worker.** `OAuthAuthorizationServer` and `OAuthResourceServer` are plain
  objects with a `fetch`; the Worker's own `fetch` hands them the paths they own and everything else goes to the
  Hono app. `queue`, `scheduled`, the Durable Objects and the workflow were untouched, and `/v1` kept working. No
  second Worker is needed.
- **The whole sign-in works with a real client library:** `401` with the resource metadata link, discovery,
  dynamic registration, PKCE, code for tokens, refresh (tokens rotate), then tool calls. The client negotiated
  protocol `2025-11-25`. Calls also work with no `initialize` first, so the handler really is stateless.
- **Client ID Metadata Documents work.** An authorize request as `https://claude.ai/oauth/claude-code-client-metadata`
  (Claude Code's real document) was fetched, validated and approved; `describeConsent()` returned the name
  "Claude Code", the verified domain `claude.ai`, and that the redirect goes to a local app.
- **Clients ask for no scopes** when the resource names none, so the consent screen alone decides what is granted.
  That is the design we want.
- **Tools from operations work unchanged.** `registerTool` takes the operation's zod schema directly;
  `op.input.omit({ organizationId: true })` hides the organization and the grant's value is filled in before
  `op.run`. A call that passed another `organizationId` got the grant's organization anyway. `ApiError` came back
  as a tool error with its code and message; bad arguments are refused by the SDK before our code runs. Calls took
  3–11 ms locally, including building the server per request.
- **Listing only granted tools works and matters.** `tools/list` for 53 tools was 41 KB (about 10,000 tokens of the
  app's context). With narrower scopes the send and setup tools were not listed and calling them returned
  "Tool not found".
- **Connected apps needs no table of our own.** `listUserGrants(userId)` returns each grant's id, client, scopes,
  created and expiry times, redirect URI and our `metadata` (stored unencrypted, so the organization and app name
  go there; `props` are encrypted). `revokeGrant` took effect on the very next call (`401`).
- **A session JWT is refused at `/mcp`** (`401`), and OAuth tokens mean nothing to `/v1`. The two don't mix.
- **`global_fetch_strictly_public` changed nothing locally:** fetches to `localhost`, `127.0.0.1`, `mx.xstate.io`
  and `api.xstate.com` all worked with it on, so `pnpm mail:dev` is unaffected. In production the flag only changes
  fetches to hosts in the Worker's own zone (xstate.com), and the API makes none except when a customer's
  connector points at xstate's own MCP URL. Not tested in production.
- **Size:** 4,573 KiB (892 KiB gzip) today, 5,259 KiB (1,036 KiB gzip) with both packages.
- **Access tokens look like `<userId>:<grantId>:<secret>`.** The user id is visible to whoever holds the token;
  nothing secret, but worth knowing when reading logs.

#### Design changes these lead to

- **The issuer is `https://mcp.xstate.com`**, and `/authorize`, `/oauth/token`, `/oauth/register` and the
  `/.well-known/*` documents live on that host next to `/mcp`. One host for clients to discover, and nothing OAuth
  on `api.xstate.com`.
- **The consent page stays in the app, without the library's consent-form helpers.** Those bind the form to a
  cookie on the issuer's origin, which a page on `go.xstate.com` can't use. Instead `/authorize` validates the
  request, keeps it in KV for 10 minutes under a random id, and redirects to `go.xstate.com/connect?request=<id>`.
  The app shows what `describeConsent()` returned (app name, verified domain or "unverified", where access is
  sent, a warning for apps on this computer) and posts the choices with the session token in the `Authorization`
  header, which another site can't forge. The id works once.
- **Reconnecting replaces only the same organization's connection.** By default the library revokes a user's
  earlier grants for the same app, which would disconnect organization A when the same app is connected to
  organization B. Pass `revokeExistingGrants: false` and revoke ourselves the earlier grants with the same app,
  redirect URI and organization.
- **Connections last while they're used.** Out of the box a grant ends 30 days after sign-in however often it is
  used. Set `refreshTokenIdleTTL` to 30 days so it ends 30 days after the last use instead. A replaced access
  token keeps working until its hour is up; a revoked grant stops at once.
- **Owners' view of every connection** has no direct lookup (grants are listed per user). For v1 list each
  member's grants; move to an index in D1 only if organizations get large.
- **Production needs a KV namespace** (`wrangler kv namespace create OAUTH_KV`) before Phase 2 deploys, and
  `purgeExpiredData()` joins the hourly cron.
- **Mail search already exists inside a folder** (`email_list_messages` takes a full-text `query`). The Phase 5
  item is only search across all folders at once.

#### Not done

- **No real app has connected yet.** Claude (web and desktop), Cursor, Codex and ChatGPT each need a person at the
  keyboard, and the web ones need a public HTTPS address. Do this at the end of Phase 2 against a tunnel, with the
  real consent page, before anything is deployed.

### 1. Server and tools (built 2026-11-16)

- `src/mcp/tools.ts`: which operations a grant lists (`grantedOperations`), what a client sees (`toolFor`), and
  the result and error shapes. No SDK or bindings, so it is unit-tested (`tools.test.ts`).
- `src/mcp/server.ts`: `callTool`, `buildServer` and `serveMcp`. Uses the SDK's low-level `Server` with our own
  `tools/list` and `tools/call` handlers, not `McpServer.registerTool`: the operation's zod schema stays the only
  validator, so the model gets the same error text as the HTTP API.
- `src/operations/schema.ts`: `toolInputSchema`, the operation's input as JSON Schema without `organizationId`.
  Agents' built-in tools use it too (`agents/tools.ts`), so there is one copy.
- **`mcp` is now required on every operation**: `false`, or `{ scope, readOnly?, destructive? }`
  (`operations/define.ts`). A new operation without a scope doesn't compile, which replaces the planned unit test.
- **Scopes:** `profile` (comes with every connection: `auth_me`, `members_list`, `storage_list_members`),
  `mail.read`, `mail.draft` (drafts, and marking or moving messages), `mail.send`, `calendar.read`,
  `calendar.write`, `storage.read`, `storage.write`, `contacts.read`, `contacts.write`, `setup`. A grant lists
  every scope it has; nothing is implied. Mail attachment tools need `mail.read`, not `storage.read`.
- **70 tools on MCP** (was 73: mailbox password reset and granting or revoking mailbox access are off). A default
  connection (draft only, the rest read) lists 33 tools in 21 KB; every scope lists 70 in 49 KB.
- **The mailbox limit is on the actor, not in the MCP layer.** `Actor.mailboxIds` (`auth/types.ts`), checked by
  `mailContext`, `readableMailboxes` and the calendar's `context` (`mailserver/access.ts`, `calendar.ts`). Every
  path to mail obeys it, including ones with no `mailboxId` argument: Storage search, attachments by file id, and
  listing every mailbox's folders. A mailbox the user can read but the connection wasn't given answers "This
  connection can't use that mailbox"; one the user can't read stays "Mailbox not found". Managing mailboxes
  (`mailboxContext`, the `setup` tools) is not limited by it.
- **Local development route** (`src/mcp/dev.ts`, 404 in production): `POST /mcp` on the API with a session token.
  Headers `X-Xstate-Organization`, `X-Xstate-Scopes` and `X-Xstate-Mailboxes` narrow the grant; without them it has
  everything. Phase 2 replaces how the grant is obtained, not `serveMcp`.

Tried locally with two shared mailboxes: scoped tool lists, a call for a tool outside the grant, a mailbox outside
the grant, another organization's id in the arguments (ignored), validation errors, and `/v1` unchanged.

Known limits, for later phases:

- `email_list_mailboxes` and `email_get_mailbox` describe every mailbox the user can see, not only the
  connection's. They show addresses and settings, no mail. The server's instructions point the model at
  `email_list_folders`, which lists only the mailboxes the connection can use.
- Tools have no `title` yet; clients show the tool name.
- **Agents had the gap the actor limit closes, fixed 2026-11-16.** An agent limited to some mailboxes could reach
  other mail the person it acts for can read through `storage_search`, because `scopeInput` only checks tools that
  take a `mailboxId`. `runBuiltin` (`agents/tools.ts`) now runs every built-in tool with the agent's mailboxes as
  `actor.mailboxIds`, so the same check in `mailserver/access.ts` applies to agents too.

### 2. Sign-in (built 2026-11-16)

- `src/mcp/oauth.ts`: the authorization server and the resource server from `@cloudflare/workers-oauth-provider`,
  built once per isolate, and `handleMcpHost`, which the Worker's `fetch` tries before the Hono app. In production
  the host decides (`MCP_URL`, `https://mcp.xstate.com`) and that host serves only `/mcp`, `/authorize`,
  `/oauth/*` and `/.well-known/oauth-*`; `api.xstate.com` serves none of them. `/authorize` validates the request,
  keeps it in KV for 10 minutes and redirects to `<APP_URL>/connect/#<id>` (in the hash, like invite links).
- `src/mcp/consent.ts` and `src/operations/connections.ts`: what the consent page calls, with the session token.
  `GET /v1/connect/requests/:id` (the app, and per organization the mailboxes this person can read and whether
  they may grant setup), `POST …/approve`, `POST …/deny`. Approve checks the organization, every mailbox and the
  setup switch against the person's real access, deletes the request (it works once), revokes an earlier grant of
  the same app, redirect URI and organization, and returns where to send the browser. All three are off MCP.
- `src/mcp/scopes.ts`: the consent choices as scopes (`scopesFor`), unit-tested.
- `apps/app/src/onboarding/connect.tsx` (`/connect/`): the consent page. Signed out, it shows the usual sign-in
  first and carries on. It shows the app's name, its verified domain or that it couldn't be checked, where access
  goes, and a warning for an app on this computer; then organization (when more than one), mailboxes (your own
  ticked, shared ones not), email level (Draft only by default), calendar, storage and contacts (Read by
  default), and Setup for owners and admins.
- Tokens: access 1 hour; a connection ends 30 days after its last refresh. `purgeExpiredData` runs in the hourly
  cron. Each connection is logged once (`mcp connected`: user, organization, app, scopes, counts).
- Config: `OAUTH_KV` binding (no id: wrangler creates the namespace on first deploy), the `mcp.xstate.com` custom
  domain, the `global_fetch_strictly_public` flag, `MCP_URL` (local: `.dev.vars`, the API's own address).
- The local-only route from Phase 1 (`mcp/dev.ts`) is gone: local development uses the real sign-in.
- `.claude/launch.json` has `api-mcp` (8794, its own state in `apps/api/.wrangler/mcp-test`) and `app-mcp` (8795).

**Local development quirk:** `wrangler dev` reports the production host (the first route) as the request's host,
not `localhost`. Outside production `handleMcpHost` therefore goes by path and puts the request (URL and `Host`)
back on `MCP_URL`, which the library and the MCP handler both check.

Tried locally end to end with the MCP SDK's client and the browser: `401` → discovery → registration →
`/authorize` → sign in on the consent page → Allow → the client's callback → tokens → 33 tools listed; a mailbox
left unticked was refused, `email_send` wasn't available. Also: reconnecting the same app to the same organization
replaced the earlier grant; Cancel sent `access_denied` back; a used id, a mailbox the person can't read, another
organization, an unknown client and an unregistered redirect URI were all refused.

Left out, against the plan:

- **Signing up from the consent page doesn't come back to it.** "Create an account" goes to the normal sign-up and
  the request is lost; the person connects again afterwards. A brand-new account has no mailbox to connect anyway.
- "Continue with Google" was removed from sign-in and sign-up on 2026-11-16 (it was only a "coming soon" button), so
  the consent page signs in with email and password only.

### 3. Safety and settings (built 2026-11-16)

- **Rate limit:** `MCP_RATE`, 120 tool calls a minute per person, app and organization (`rateKey` in
  `mcp/tools.ts`), not per grant: the library doesn't give the MCP handler the grant id, and there is one grant per
  app per organization anyway. Over the limit, the call comes back as a `rate_limited` tool error. `tools/list` isn't
  counted.
- **Logging:** one `mcp call` line per tool call (`callTool` in `mcp/server.ts`): tool, ok or error code, ms, user,
  organization, OAuth client id and app name. Never arguments or results. Plus `mcp connected` and
  `mcp disconnected` lines. The grant's props now carry the app's name (`Grant.app`) for these lines; grants made
  before it don't have it (logged as null).
- **Settings → Connected apps** (`apps/app/src/settings/ConnectedApps.tsx`): the MCP address to copy; your apps;
  for owners and admins, everyone's. Each row: app, verified domain or "unverified app", who (in everyone's list),
  what it may do in the consent page's words, mailboxes, connected date and last active, Disconnect.
- **Operations** `connections_list` (`GET /v1/orgs/:organizationId/connections`) and `connections_revoke`
  (`DELETE …/connections/:connectionId`), off MCP (`mcp/connections.ts`). A connection is a grant whose metadata
  names the organization, found through each active member's grant list (one KV list per member for owners and
  admins). Someone may only revoke what they can list; anything else is "Connection not found".
- **Last active** is worked out, not stored: a grant's expiry moves to 30 days after each refresh
  (`refreshTokenIdleTTL`), and apps refresh about hourly while used, so last active = expiry − 30 days, within about
  an hour. Checked locally: a refresh moved the expiry.
- Sign-ins left halfway (approved, but the app never collected its tokens) have no expiry and aren't listed.
- `MCP_URL` in the app (`lib/core.ts`) is the address shown on the page: the local API's `/mcp` in development.

Tried locally with two people in one organization (owner and member), each with an app: the owner saw both, the
member only theirs; the member couldn't disconnect the owner's app; the owner disconnected the member's and its
token got `401` on the next call; 125 calls in a row gave 120 results and 5 `rate_limited`, while another
connection kept working; Disconnect from the page in the browser.

Left out:

- **Mobile** Connected apps. The plan said "web; mobile later".
- **Removing a member doesn't revoke their grants.** They stop working at once (every call checks membership),
  but stay in KV until they expire, and drop out of the owner's list because only members are listed.
- Apps that register themselves anew on every sign-in (dynamic registration) show up once per sign-in, because
  each is a new client to xstate. Clients using a metadata document (Claude, ChatGPT, Cursor) don't.

### 4. Make the promises true (built 2026-11-16)

- **Onboarding step 5** (`apps/app/src/onboarding/AgentStep.tsx`): the address is `MCP_URL` from `lib/core.ts`
  (`https://mcp.xstate.com/mcp`; the old `/sse` constant in `state.ts` is gone). Current steps per app, checked
  against each vendor's docs on 2026-11-16: Claude (Customize → Connectors → Add custom connector), Claude Code
  (`claude mcp add --transport http`, then `/mcp`), Codex (`codex mcp add --url`, then `codex mcp login`), Cursor
  (`~/.cursor/mcp.json`, then Connect in its MCP settings). The Addresses and Access level fields are gone. The step
  checks every 5 seconds for a connection and shows "Connected: <app>" once one appears.
- **Done screen:** "Connect an AI agent" is ticked when this person has a connection, not when they clicked
  Continue. `Progress.agent` keeps only the picked app.
- **`/docs/mcp`** (`apps/web/content/docs/mcp.md`, "Connect AI apps"): the address, how to connect each app
  (ChatGPT described loosely: its menus and plan rules vary and weren't confirmed), what the consent page shows and
  asks, what an app can never do, managing and disconnecting, a prompt-injection warning, the tool list, and a
  section for developers (transport, OAuth discovery, client registration, scopes, tokens, errors). Linked from
  the docs home and the quickstart.
- **The tool list is generated** from the operations: `pnpm --filter @xstate/api docs:mcp` rewrites the block
  between the `mcp-tools` markers (`apps/api/scripts/mcp-tools-doc.ts`, run through esbuild by
  `mcp-tools-doc.mjs` with the Workers-only modules stubbed). `pnpm --filter @xstate/api test` now also fails when
  the list is out of date. `esbuild` 0.28.2 became a dev dependency of the API (the version wrangler already uses).
- **`/.well-known/mcp.json`:** the link is removed from the marketing footer. No settled format is read there by
  the clients we support, so nothing is published. The MCP claims on the marketing page now match what exists:
  ChatGPT added, "label permissions" and "Per-agent audit log" replaced by mailbox choice and Disconnect, and no
  MCP manifest.

Checked locally in the browser: step 5 for each app, the status line, the Done screen ticked from a real
connection, and `/docs/mcp` from a production build (renders, tables included, listed in `/llms.txt`).

Not touched, but untrue on the marketing page today: `/openapi.json`, `/index.json`, `/docs/api`, `/status`,
`/changelog`, `/blog` and the sample changelog post "catch-all, JMAP, MCP manifest". Outside this plan.

### 5. Later

- **Mobile** Settings → Connected apps.
- Mail search across all folders at once (today `email_list_messages` searches one folder).
- **Done 2026-11-16:** `storage_read_attachment_text` (`GET /v1/storage/attachments/:fileId/text`, scope
  `mail.read`) reads a mail attachment's whole text, PDFs through the same extraction as search and
  `storage_read_text`, with the same access check as downloading it. `storage_search` takes `fileId` to ask one
  file only (Vectorize filter on the `doc` metadata index, no 3-passages-per-file cap; the usual permission check
  still runs). Found while summarising a contract over MCP: a dozen near-identical PDFs outranked it, and nothing
  could read an attachment whole. Tried locally with a test PDF and Markdown file sent between two mailboxes.
- `storage_search` needs `storage.read`, though it also searches mail: a connection with Storage off can't search
  mail at all. Worth splitting by what the grant allows.
- Read-only agent run history on MCP.
- Personal access tokens or the organization secret key for headless clients.
- Listing in the Claude and ChatGPT connector directories.

## Before deploying

Decided 2026-11-16: no testing with real apps over a tunnel first. Nobody but the owner uses xstate yet, so the real
apps are tested on production right after the deploy.

1. **Deploy the API, the app and the docs site together** (API first). No new D1 migrations and no new secrets.
   The first API deploy creates the `mcp.xstate.com` custom domain (DNS record and certificate; `xstate.com` is on
   Cloudflare, no manual DNS). The `OAUTH_KV` namespace (`xstate-api-oauth`) was created by hand on 2026-11-16
   and its id is in `wrangler.jsonc`: the GitHub deploy token can't create KV namespaces, which failed the first two
   deploys.
2. **Check:** `https://mcp.xstate.com/.well-known/oauth-authorization-server` names `https://mcp.xstate.com` as
   issuer, and `POST https://mcp.xstate.com/mcp` without a token answers `401`.
3. **Connect the real apps** with `https://mcp.xstate.com/mcp` and a real account: Claude (web and desktop),
   Claude Code, Codex, Cursor, ChatGPT. Then Settings → Connected apps and Disconnect. Read the `mcp call`,
   `mcp connected` and `mcp disconnected` lines in the Worker logs.

Local tunnel testing stays possible: `api-mcp` / `app-mcp` in `.claude/launch.json` with
`MCP_URL` set to a `cloudflared tunnel --url http://localhost:8794` address, and the test account in
`apps/api/.wrangler/mcp-test` (gitignored).

## Decided (user, 2026-11-16)

1. **OAuth only for v1.** Tokens for headless clients come later.
2. **Default email access is "Draft only".**
3. **Setup tools sit behind an admin-only switch** on the consent screen.
4. **Onboarding loses the address and access fields**; the consent screen asks for real.
