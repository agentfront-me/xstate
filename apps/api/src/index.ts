import { Hono } from 'hono'
import { handleOAuthCallback } from './agents/connectors'
import { handleWebhook } from './agents/triggers'
import { handleCollect } from './audience/collect'
import { snippet } from './audience/snippet'
import { consume, hourly, type MailSyncJob } from './jobs/mail-sync'
import { consume as consumeSearch, hourly as searchHourly, type SearchJob } from './search/jobs'
import { finalHourly } from './migration/final'
import { migrationHourly } from './migration/watchdog'
import { consumeMigration, consumeMigrationDead, type MigrationJob } from './migration/jobs'
import { handleSesWebhook } from './jobs/ses-webhook'
import { handleSesInbound } from './jobs/ses-inbound'
import { handlePaddleWebhook } from './billing/webhook'
import { billingHourly } from './billing/service'
import { handleStalwartWebhook } from './jobs/stalwart-webhook'
import { consumePush, type PushJob } from './push/send'
import { consumeStore, type MailboxStoreJob } from './mailbox/jobs'
import type { InboundJob } from './mailbox/inbound'
import { consumeInbound } from './mailbox/receive'
import { consumeMailEvents, type MailEvent } from './mailbox/events'
import { cors } from 'hono/cors'
import { tokensHourly } from './auth/api-tokens'
import { emailsHourly } from './emails/service'
import { requireAuth, requireToken } from './auth/middleware'
import { handleLive } from './live/route'
import { handleGetEmail, handleListEmails, handleSendEmail } from './http/emails'
import { handleStorageSave, handleStorageUpload } from './http/storage-uploads'
import { handleAttachmentUpload } from './http/uploads'
import { mountOperations, onError } from './http/router'
import { sendingHourly } from './mailserver'
import { handleMcpHost, purgeOAuth } from './mcp/oauth'
import { sesHourly } from './mailserver/domains'
import type { AppEnv } from './http/types'
import { operations } from './operations'

const app = new Hono<AppEnv>()

app.get('/', (c) => c.json({ message: 'Hello from xstate' }))

app.get('/health', (c) => c.json({ ok: true, service: 'api', time: new Date().toISOString() }))

// Audience tracking from customers' websites: any origin may call it (it's authenticated by the key in the body),
// so it gets its own CORS rule ahead of the dashboard's. See audience/collect.ts and audience/snippet.ts.
app.use('/v1/collect', cors({ origin: '*', allowMethods: ['POST'], allowHeaders: ['Content-Type', 'Authorization'], maxAge: 86400 }))
app.post('/v1/collect', handleCollect)
app.get('/js/xstate.js', (c) =>
  c.body(snippet(`https://${new URL(c.req.url).host}`), 200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  }),
)

const v1 = new Hono<AppEnv>()
// The dashboard, sign-up and onboarding pages on go.xstate.com call the API from the browser.
v1.use('*', (c, next) =>
  cors({
    origin: (origin) => (c.env.APP_ORIGINS.split(',').includes(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // Attachment downloads say why a file needs care (security/attachments).
    exposeHeaders: ['X-Attachment-Warning'],
    maxAge: 600,
  })(c, next),
)
// Uploads and saved file contents take the file itself as the body, not JSON, so they get their own routes.
v1.post('/email/mailboxes/:mailboxId/uploads', requireAuth, handleAttachmentUpload)
v1.post('/storage/orgs/:organizationId/files', requireAuth, handleStorageUpload)
v1.put('/storage/items/:itemId/content', requireAuth, handleStorageSave)
// Sending email from a customer's own server, with a personal API token instead of a session (http/emails.ts).
v1.post('/emails', requireToken, handleSendEmail)
v1.get('/emails', requireToken, handleListEmails)
v1.get('/emails/:id', requireToken, handleGetEmail)
// The mobile app's live updates: a WebSocket per member while the app is open (live/hub.ts).
v1.get('/live/orgs/:organizationId', handleLive)
mountOperations(v1, operations)
app.route('/v1', v1)

// Stalwart calls this when mail arrives in any account (signed; not part of the public /v1 API).
app.post('/webhooks/stalwart', handleStalwartWebhook)
// Amazon SES bounces and complaints, delivered by SNS (signed by SNS; not part of the public /v1 API).
app.post('/webhooks/ses', handleSesWebhook)
// Mail received through SES for store-held mailboxes, delivered by SNS (signed; mailbox/receive.ts).
app.post('/webhooks/ses-inbound', handleSesInbound)
// Paddle subscription events (signed with PADDLE_WEBHOOK_SECRET; billing/webhook.ts).
app.post('/webhooks/paddle', handlePaddleWebhook)
// Agents' webhook triggers (agents/triggers.ts): signed with the trigger's secret, or the secret in the URL.
app.post('/hooks/:triggerId', handleWebhook)
app.post('/hooks/:triggerId/:token', handleWebhook)
// Connectors' OAuth sign-in comes back here, then on to Settings → Connectors (agents/connectors.ts).
app.get('/connectors/oauth/callback', handleOAuthCallback)

app.onError(onError)
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404))

// One per organization: its audience (people, events, segments). See audience/store.ts.
export { AudienceStore } from './audience/store'
// One per Google Workspace import: what was copied, and what was skipped. See migration/store.ts.
export { MigrationStore } from './migration/store'
// One per agent: its runs and their steps (agents/store.ts). Each run is an AgentRun workflow (agents/run.ts).
export { AgentStore } from './agents/store'
export { AgentRun } from './agents/run'
// One per organization: live-updates sockets for the apps. See live/hub.ts.
export { LiveHub } from './live/hub'
// One per mailbox: its message index, a shadow copy of Stalwart for now (mailbox/store.ts).
export { MailboxStore } from './mailbox/store'

export default {
  // mcp.xstate.com (the MCP server and its OAuth sign-in, mcp/oauth.ts) is this same Worker; everything else is the API.
  fetch: (request, env, ctx) => handleMcpHost(request, env, ctx) ?? app.fetch(request, env, ctx),
  // MAIL_SYNC jobs: copy a mailbox's new attachments to R2 (from the webhook or the hourly check).
  // SEARCH_INDEX jobs: index a file for Storage search.
  // MIGRATION jobs: Google Workspace imports (migration/jobs.ts).
  // PUSH jobs: notifications to the mobile app (push/send.ts).
  // STORE_COPY jobs: copying mail into mailbox stores (mailbox/jobs.ts).
  // MAIL_IN jobs: mail received through SES, delivered into mailbox stores (mailbox/receive.ts).
  // MAIL_EVENTS jobs: new, moved and removed mail in store-held mailboxes, for filing, search and agents.
  queue: (batch, env) =>
    batch.queue === 'xstate-search-index'
      ? consumeSearch(batch as MessageBatch<SearchJob>, env)
      : batch.queue === 'xstate-migration'
        ? consumeMigration(batch as MessageBatch<MigrationJob>, env)
        : batch.queue === 'xstate-migration-dlq'
          ? consumeMigrationDead(batch as MessageBatch<MigrationJob>, env)
          : batch.queue === 'xstate-push'
            ? consumePush(batch as MessageBatch<PushJob>, env)
            : batch.queue === 'xstate-mailbox-store'
              ? consumeStore(batch as MessageBatch<MailboxStoreJob>, env)
              : batch.queue === 'xstate-mail-in'
                ? consumeInbound(batch as MessageBatch<InboundJob>, env)
                : batch.queue === 'xstate-mail-events'
                  ? consumeMailEvents(batch as MessageBatch<MailEvent>, env)
                  : consume(batch as MessageBatch<MailSyncJob>, env),
  // Hourly: safety-net mail sync in case webhooks were lost, purge of files deleted over 30 days ago, and the
  // search backfill and sweep, and syncing sending suspensions to Stalwart.
  scheduled: (_controller, env, ctx) =>
    ctx.waitUntil(
      Promise.all([
        hourly(env),
        // Connected apps: expired grants and tokens KV's own expiry missed.
        purgeOAuth(env).catch((err) => console.error('oauth purge failed', err)),
        sendingHourly(env).catch((err) => console.error('sending-hourly failed', err)),
        // Personal API tokens: the "ends in a week" email, and removal of long-ended ones.
        tokensHourly(env).catch((err) => console.error('tokens-hourly failed', err)),
        // The send log of POST /v1/emails: messages older than 30 days.
        emailsHourly(env).catch((err) => console.error('emails-hourly failed', err)),
        // Billing: every paying organization billed for its current number of people.
        billingHourly(env).catch((err) => console.error('billing-hourly failed', err)),
        // SES verifies DKIM on its own schedule: pick up domains it has verified since they were last checked.
        sesHourly(env).then(
          (r) => r.changed && console.log('ses-hourly', JSON.stringify(r)),
          (err) => console.error('ses-hourly failed', err),
        ),
        // Google Workspace imports: the automatic second final pass, 24 hours after the first.
        finalHourly(env).catch((err) => console.error('migration final-hourly failed', err)),
        // Lost job chains restarted, the "copy is ready" email, Google access checks after an import, store cleanup.
        migrationHourly(env),
        searchHourly(env).then((r) => {
          if (r.queued || r.retried || r.swept || r.sweepFailed) console.log('search-hourly', JSON.stringify(r))
        }),
      ]),
    ),
} satisfies ExportedHandler<Env, MailSyncJob | SearchJob | MigrationJob | PushJob | InboundJob | MailEvent>
