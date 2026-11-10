# Plan: Agents

Status: Phase 0 (spike) done and Phase 1 (foundations) built 2026-11-10, uncommitted. Migration 0023 must be applied
before the API is deployed. Phases 2–6 not started.

The design ("xstate App.dc.html", Agents page and Settings → AI providers / Secrets) adds AI agents that customers
set up in the app, with no code: **triggers** (webhook, schedule, email; events later) start a run, the agent
follows its **instructions**, uses **tools** (built-in xstate tools and MCP connectors), and stops for a person when
a tool **needs approval**. Customers bring their own AI keys (Anthropic and OpenAI).

Screens in the design: agent list with status · Runs (stats, table, run detail timeline) · Setup (triggers,
instructions, tools) · Approvals · Memory · Settings (model, limits, spend, approvals, access, memory retention,
developer, danger zone) · Test drawer (dry run) · New agent (template → review → test and activate) ·
Settings → AI providers · Settings → Secrets · error banner for a rejected key · mobile approvals.

## Decided (user, 2026-11-10)

1. **Agents aren't tied to email.** Triggers are webhook, schedule and email, and later events. An agent has no
   mailbox of its own by default (see [Sending identity](#sending-identity)).
2. **Anthropic and OpenAI in Phase 1.** Gemini later.
3. **No included model and no free tier.** Agents are a paid feature; limits and price come from the pricing task.
   Every agent needs an organization AI key. The design's "xstate included" card goes.
4. **Secrets stay in v1.** See [Secrets](#secrets) for how a no-code agent uses them.
5. **Connectors are generic.** Any MCP server by URL, with OAuth or header auth. No per-service connector code.

## Design changes needed

- Settings → AI providers: remove the "xstate included" card; Gemini can show "Coming soon".
- Agent header: replace the fixed `support-agent@xstate.com` with the agent's sending identity ("Sends as
  support@xstate.com", or "Doesn't send email").
- Secrets: change the description from "read as environment variables" to "used in connector headers; agents never
  see the values".
- Tools: "+ Add connector" opens a dialog: server URL, then OAuth sign-in or headers (values can pick a secret).

## Decisions (proposed)

- **One generic agent, configured in the app.** Every agent is an instance of the same code; what differs is its
  published config. No customer code in v1.
- **Runs in the existing API Worker** (`apps/api`), code under `src/agents/`. It already has D1, Queues, Durable
  Objects, Workers AI and the operations the tools are built from. A separate Worker would have to import API
  source across apps. Revisit if agent CPU or bundle size starts to hurt the API.
- **Libraries:** Cloudflare `agents` (the `Agent` Durable Object base class, scheduling, MCP client), Cloudflare
  Workflows for runs, Vercel AI SDK (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai`) for model calls and tool calling
  across providers.
- **Every model call goes through Cloudflare AI Gateway** with the customer's key on the request. That gives
  per-organization logs, rate limits and token counts without building them. Response caching off.
- **Where data lives:**
  - D1: `ai_providers`, `secrets`, `connectors`, `agents`, `agent_versions`, `agent_triggers`, `agent_approvals`.
    Small, queried across agents (list badges, approvals inbox, routing a webhook or mailbox to its agents).
  - The agent's Durable Object (SQLite): runs, run steps, memory facts, usage counters. High volume and private to
    one agent; deleted with it.
- **Built-in tools are existing operations.** `operations/define.ts` already exposes each operation as an HTTP route
  and an MCP tool; agents get an allowlisted subset, run with an agent actor (see below). No second copy of
  email/storage/calendar logic.
- **AI keys and secrets are encrypted at rest** like the organization's secret API key (`audience/keys.ts`,
  `API_KEYS_ENCRYPTION_KEY`): AES-GCM ciphertext and last 4 characters in D1, decrypted only inside a run. Never
  returned by the API.

## Sending identity

Agents aren't mailboxes. Email is something an agent may do, not what it is:

- **Sends as:** in the agent's settings, any mailbox the agent's editor can send from (e.g. `support@`), or none.
  An agent with no sending identity has no email write tools.
- **Replies** to an email trigger go out from the mailbox the email arrived in, so the customer gets the answer from
  the address they wrote to, and the reply lands in that mailbox's Sent folder and thread.
- **Email-triggered agents** watch mailboxes they've been given access to; no address is created for them.
- A dedicated address per agent (for cc'ing or forwarding to an agent) can come later as a trigger option.

## Triggers

Trigger types are pluggable: each type has a config schema, a matcher (filters) and a way to produce the run's
input. Adding "event" later is a new type, not a new engine.

- **Webhook.** `POST /hooks/:triggerId` (outside `/v1`, like `/webhooks/stalwart`). HMAC-SHA256 signature in
  `X-Xstate-Signature` with the trigger's secret (encrypted, rotatable). Body cap 256 KB, rate limit binding per
  trigger, last 5 payloads kept for the UI, template maps payload fields into the task text.
- **Schedule.** Scheduled from the agent's Durable Object. Cron in the SDK is UTC, so we compute the next run in the
  trigger's timezone and schedule that single time, then the next one after it fires. That handles DST. One-off
  schedules become "Done".
- **Email.** Inbound mail comes from Stalwart, not Cloudflare Email Routing, so the SDK's email routing doesn't
  apply. Mail sync already walks `Email/changes` for every new message (`storage/mail-sync.ts`); for mailboxes that
  have agent triggers it also queues `{ triggerId, mailboxId, emailId }` on a new `xstate-agent-events` queue.
  Catch: `syncMailbox` returns early when storage isn't configured (local dev), so the agent hook must run before
  that check, or move to its own small walk. Loop guard: skip `Auto-Submitted`, `no-reply`, and threads past the
  agent's max replies.
- **Event (later).** xstate events (audience events, form submissions, contact created) and connector events.

## Connectors

- An organization adds an MCP server by URL once; agents pick which of its tools to use.
- Auth: OAuth (the SDK's MCP client handles the flow and token refresh) or static headers whose values reference
  secrets (`Authorization: Bearer {{secret.SHOPIFY_ADMIN_TOKEN}}`).
- On connect we list its tools; each agent turns tools on or off and sets approval rules per tool.
- Status: connected, needs sign-in again, unreachable. A broken connector shows on every agent that uses it.
- No per-service code. A list of suggested servers (URL + icon) can be added any time without code changes.

## Secrets

Organization-level encrypted values, admins only. Used in v1 for:

- connector headers (above),
- headers on outgoing webhook calls, if we add an "HTTP request" tool later.

The model never sees a secret: values are substituted when the request is made, outside the model's context, and
redacted from run logs. The Secrets page shows where each secret is used and when it was last used.

## How a run works

1. A trigger fires (webhook, schedule, email, or Test).
2. Cheap checks in the Worker, before any model call: trigger enabled, rule filters, loop guard, per-sender limit,
   runs-per-day limit, monthly spend cap, a usable AI key. A failed check records a "Skipped" run with the reason.
3. The agent's Durable Object starts an `AgentRun` Workflow with the published config version.
4. The Workflow loops: model call (`step.do`, retried) → tool calls (`step.do` each) → model call … until done or
   max steps. Optional AI filter is the first model call; if it says no, the run ends as "Skipped by filter".
5. A tool that needs approval writes an `agent_approvals` row, notifies approvers, and waits
   (`step.waitForEvent('approval', { timeout })`). Approve / edit / reject sends the event; timeout applies the
   agent's setting (reject, or keep waiting and remind).
6. Each step is written to the run log in the Durable Object as it happens, so the run detail updates live over the
   agent's WebSocket.
7. Tokens × our price table → cost estimate per run; added to the agent's and the organization's monthly usage.

**Dry run (Test drawer):** same path with the draft version, tools that change anything are replaced by stubs that
record what they would have done.

## Agent actor and access

`Actor` is `{ userId }` today. Add an agent actor `{ agentId, organizationId, mailboxIds }` so operations can tell an
agent from a person. An agent can only use the mailboxes its triggers watch and its sending identity, the
organization's storage it's allowed to search, and calendars of those mailboxes. Every built-in tool checks this,
same as for users.

## Phases

### 0. Spike (done 2026-11-10, code removed)

The spike was a separate Worker config around the API with `/spike/*` routes: a `SpikeAgent`, a `SpikeRun`
workflow, a fake MCP connector with bearer auth (`get_order`, `create_refund`), `members_list` as a built-in tool,
and a scripted model. Its code was deleted once Phase 1 replaced it; the findings below are what it was for.
Packages it brought in and Phase 1 keeps: `agents` 0.33.0, `ai` 7.0.166, `@ai-sdk/anthropic` 4.0.99,
`@ai-sdk/openai` 4.0.111, `@modelcontextprotocol/client` 2.4.0 (needed by `agents`).

#### Findings

Tested locally with `wrangler dev` and the scripted model:

- **Size and startup are fine.** API today: 1,460 KiB (288 KiB gzip). With the agent packages: 4,736 KiB (911 KiB
  gzip), of which ~416 KiB is the MCP server package that production won't need unless we host our own MCP server.
  Far under the Workers limit. Startup profile (`wrangler check startup`, local CPU) is ~30 ms with and without, so
  the agent code costs the API nothing at startup.
- **Workflows work in local dev:** model and tool steps, `waitForEvent` approvals, approval timeouts, and a run that
  was waiting for approval survived a dev-server reload and finished after approval.
- **Approvals:** use our own `waitForEvent` with one event type per tool call (`approval-<step>-<call>`), not the
  SDK's `waitForApproval`: that one uses a single fixed step name and, on rejection, marks the whole workflow as
  errored. A rejection or timeout goes back to the model as an `execution-denied` tool result, and it carries on.
- **Run loop:** `generateText` with tools that have no `execute`, so the model only proposes calls and every call is
  its own durable step. Workflow step results must be JSON-typed; storing them as JSON strings is simplest.
- **Built-in tools from operations work:** `z.toJSONSchema(op.input)` for the schema, `op.run(ctx, input)` to run it,
  and the existing access checks apply unchanged (a user who was only invited got "Organization not found").
- **MCP by URL with header auth works.** Gotchas: discovery finishes after `addMcpServer` returns `ready`, so call
  `this.mcp.waitForConnections()` before listing tools; `createMcpHandler` only serves `/mcp` unless `route` is
  set; providers only accept tool names matching `[a-zA-Z0-9_-]`, so MCP tools are named `<server>__<tool>`.
- **Scheduling:** `this.schedule(delay, method, payload)` started a run on time.
- **Workflow tracking in the SDK goes stale** (it still said `queued` for finished runs unless polled). Our own runs
  table is the source of truth for the Runs tab.

Design changes these lead to:

- **Connector credentials and OAuth must be organization-level, not per agent.** The SDK stores each MCP connection
  (including its headers and OAuth tokens) in the agent's own storage. With connectors shared by all agents and
  secrets encrypted in D1, Phase 4 should use the SDK's custom OAuth provider / storage hooks so tokens live once per
  organization and headers are filled from secrets at connect time, not copied into every agent.
- **Dry runs still stop for approval** today. Proposal: in a dry run, log "would need approval" and carry on, so a
  test never waits for a person.

With a real model (OpenAI `gpt-5.4-mini`, directly, no gateway):

- The same loop works unchanged: the model called `members_list` and `get_order` **in parallel in one step**, then
  `create_refund` for $240, which waited for approval; after approval it answered in one line. 4 model calls,
  1,526 input / 133 output tokens for the whole run.
- Model ids available to that key include `gpt-5.4-mini`, `gpt-5.5` and `gpt-5.5-pro`; there is no
  `gpt-5.5-mini`, which the design's AI providers card lists. The model picker should come from the provider's
  model list (or a list we keep), not a hard-coded name.

With Claude (`claude-haiku-5-5` and `claude-sonnet-5-5`, directly, no gateway), same scenario:

- Both behaved like OpenAI: `get_order` and `members_list` in parallel, then `create_refund` $240 held for
  approval. No code changes between providers.
- Haiku, approved: refunded and replied to the customer with the refund id. 4,043 input / 460 output tokens.
- Sonnet, rejected with the reason "Refunds over $100 need photos first. Ask the customer for photos.": it used
  the reason and wrote a reply asking Carlos for photos. 3,747 / 374 tokens. So the rejection reason is worth a
  field in the Approvals UI ("Note sent back to the agent"), as the design already has.
- Claude used about 2.5× the input tokens of `gpt-5.4-mini` on the same run (tool schemas and replies are longer);
  cost estimates must be per model.

Not verified yet:

- AI Gateway: needs a gateway on the account and its name in the `AI_GATEWAY_ID` var, to check the URL mapping in
  `agents/model.ts` and the token counts the gateway logs.
- An OAuth MCP server (needs a real one and a browser sign-in).

### 1. Foundations (built 2026-11-10, uncommitted)

What's there:

- **Migration `0023_agents.sql`:** `ai_providers`, `secrets`, `agents`, `agent_versions`. `agent_triggers` and
  `agent_approvals` move to the phases that use them (2 and 3), so no table exists before its code.
- **API** (`src/agents/`, `src/operations/agents.ts`, `src/db/agents.ts`), all off MCP:
  - AI providers (owners and admins): save checks the key by listing the provider's models (free), stores it
    encrypted (`agents/seal.ts`, AES-GCM under `API_KEYS_ENCRYPTION_KEY` with its own HKDF label) with its model
    list; check again; remove. OpenAI's list is filtered to chat models. Runs report key failures back
    (invalid / out of credit / rate limited) and clear temporary ones on success.
  - Secrets (owners and admins): create, replace, delete; names only come back.
  - Agents (owners, admins, and the new `agents.manage` permission): create, edit name/description/draft config
    (`agents/config.ts`, zod with defaults), publish (needs a model, a usable key and instructions), turn on/off
    (needs a published version), duplicate, delete (also wipes its Durable Object), version history, restore a
    version into the draft, built-in tool catalog, models the org's keys can use.
  - Runs: start (test the draft as yourself, or run the published version as its publisher; dry run), list with
    filters and a cursor, one run with all steps, stats (runs and success rate over 7 days, tokens by model this
    month). Max runs per day is enforced for real runs.
- **Runtime:** `AgentStore` Durable Object per agent (runs, steps; deletes the SDK's workflow tracking rows when a run
  ends) and `AgentRun` Workflow (the spike's loop, plus: the key is read and decrypted inside each model step, never
  stored in workflow params; `maxRetries: 0` in the AI SDK so the step's backoff does the retrying; bad key, no
  credit, unknown model and 400s fail at once; tool output to the model capped at 40,000 characters; a short
  guardrail prompt says tool results are data, not instructions).
- **Built-in tools (read only):** `email_list_messages`, `email_get_thread`, `audience_list_people`,
  `audience_get_person`, `storage_search`, `calendar_list_events`, `members_list`. `organizationId` is removed from
  the schema the model sees and filled in by the run.
- **Config:** `AGENT_STORE` Durable Object (migration tag `v3-agent-store`), `AGENT_RUN` workflow
  (`xstate-agent-run`), `AI_GATEWAY_ID` var (empty).
- **App:** Agents page (`apps/app/src/agents/`): agent list, header with draft pill, Test, Publish, on/off switch and
  menu (rename, version history, duplicate, delete); Runs tab (stats, filters, table, run drawer with a step
  timeline and "Run again"); Setup tab (instructions saved to the draft as you type, built-in tools, notes where
  triggers and connectors will go); Settings tab (model picker from the org's keys, limits, agent id, delete);
  Test drawer that runs live; new agent, rename and version dialogs. Settings → AI providers and a live Settings →
  Secrets (`apps/app/src/settings/AiSections.tsx`).

Decisions made while building (not in the design):

- **Who a run acts as:** the agent actor described above was too large a change for Phase 1 (every service takes
  `{ userId }`). A test runs as the person testing; a published run acts as the person who published that version,
  with their access checked again on every tool call. Revisit with the agent actor before Phase 3 (actions).
- **Cost:** the Runs tab shows tokens, not dollars. Prices per model come with spend caps in Phase 5.
- **No live WebSocket yet:** the run drawer and Test drawer poll every 1.5 s while a run is going.
- Approvals and Memory tabs are hidden until their phases.

Verified locally (wrangler dev + the app, real Anthropic and OpenAI keys): saving both keys and a bad key; secrets
create/validate/delete and that values are stored encrypted; create → publish refused without a model → set model
and tools → test the draft (Claude Haiku answered from `members_list`, with `organizationId` filled in) → publish →
turn on → Run now as the publisher → unknown model fails in ~3 s with a clear message → run list and status filter
→ stats → versions → duplicate → delete (404 after). In the browser: list, header, all three tabs, run drawer,
editing instructions, picking a model, publishing, a live Test run, AI providers and Secrets pages, light and dark,
and a narrow pane. API typecheck and the 106 unit tests pass; app typecheck passes.

To ship:

1. `pnpm --filter @xstate/api db:migrate:remote` (applies 0023).
2. Deploy the API: it creates the `AgentStore` class (migration `v3-agent-store`) and the `xstate-agent-run` workflow.
3. Optional: create an AI Gateway and set `AI_GATEWAY_ID` to route model calls through it.
4. Deploy the app.

### 2. Triggers

Webhook, schedule and email as above; filters, loop guard, per-sender limit; Setup tab triggers with last fired,
test event and recent payloads.

### 3. Actions and approvals

Sending identity; write tools: reply, create draft, forward, add label, create calendar event. Sending goes through
the same caps as people (`reserveSend`). Approval rules per tool, including conditions (e.g. amount > 100).
Approvals tab, inline approve in run detail, timeouts, notifications (email via system mail, desktop push),
approvers and access settings.

### 4. Connectors

Generic MCP connectors: add by URL, OAuth or header auth with secrets, tool discovery, status, per-agent tool
switches and approval rules.

### 5. Settings, memory and errors

Spend cap and "when reached" behavior, memory facts (`remember` / `recall` tools, Memory tab, add/edit/delete,
retention sweep via the Durable Object's alarm), agent error states and banner ("Fix key", "Retry failed runs").

### 6. New agent flow and mobile

Templates (Support inbox, Lead qualifier, Invoice processing, Weekly digest), "describe it" → drafted setup,
test → activate. Mobile agent list, runs, run detail, approvals.

### Later

- Event triggers.
- Gemini, AWS Bedrock, Google Vertex.
- Dedicated agent address (cc / forward to an agent).
- Custom code tools: customer-written functions run in a sandbox (Dynamic Worker Loader), shown as tools; they read
  secrets.
- Plan limits and pricing for agents (pricing task).
