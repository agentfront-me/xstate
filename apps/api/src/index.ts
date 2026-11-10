import { Hono } from 'hono'
import { handleOAuthCallback } from './agents/connectors'
import { handleWebhook } from './agents/triggers'
import { handleCollect } from './audience/collect'
import { snippet } from './audience/snippet'
import { consume, hourly, type MailSyncJob } from './jobs/mail-sync'
import { consume as consumeSearch, hourly as searchHourly, type SearchJob } from './search/jobs'
import { finalHourly } from './migration/final'
import { migrationHourly } from './migration/watchdog'
import { consumeMigration, type MigrationJob } from './migration/jobs'
import { handleSesWebhook } from './jobs/ses-webhook'
import { handleStalwartWebhook } from './jobs/stalwart-webhook'
import { cors } from 'hono/cors'
import { requireAuth } from './auth/middleware'
import { handleStorageSave, handleStorageUpload } from './http/storage-uploads'
import { handleAttachmentUpload } from './http/uploads'
import { mountOperations, onError } from './http/router'
import { sendingHourly } from './mailserver'
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
    maxAge: 600,
  })(c, next),
)
// Uploads and saved file contents take the file itself as the body, not JSON, so they get their own routes.
v1.post('/email/mailboxes/:mailboxId/uploads', requireAuth, handleAttachmentUpload)
v1.post('/storage/orgs/:organizationId/files', requireAuth, handleStorageUpload)
v1.put('/storage/items/:itemId/content', requireAuth, handleStorageSave)
mountOperations(v1, operations)
app.route('/v1', v1)

// Stalwart calls this when mail arrives in any account (signed; not part of the public /v1 API).
app.post('/webhooks/stalwart', handleStalwartWebhook)
// Amazon SES bounces and complaints, delivered by SNS (signed by SNS; not part of the public /v1 API).
app.post('/webhooks/ses', handleSesWebhook)
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

export default {
  fetch: app.fetch,
  // MAIL_SYNC jobs: copy a mailbox's new attachments to R2 (from the webhook or the hourly check).
  // SEARCH_INDEX jobs: index a file for Storage search.
  // MIGRATION jobs: Google Workspace imports (migration/jobs.ts).
  queue: (batch, env) =>
    batch.queue === 'xstate-search-index'
      ? consumeSearch(batch as MessageBatch<SearchJob>, env)
      : batch.queue === 'xstate-migration'
        ? consumeMigration(batch as MessageBatch<MigrationJob>, env)
        : consume(batch as MessageBatch<MailSyncJob>, env),
  // Hourly: safety-net mail sync in case webhooks were lost, purge of files deleted over 30 days ago, and the
  // search backfill and sweep, and syncing sending suspensions to Stalwart.
  scheduled: (_controller, env, ctx) =>
    ctx.waitUntil(
      Promise.all([
        hourly(env),
        sendingHourly(env).catch((err) => console.error('sending-hourly failed', err)),
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
} satisfies ExportedHandler<Env, MailSyncJob | SearchJob | MigrationJob>
