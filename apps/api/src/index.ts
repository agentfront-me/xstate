import { Hono } from 'hono'
import { consume, hourly, type MailSyncJob } from './jobs/mail-sync'
import { handleStalwartWebhook } from './jobs/stalwart-webhook'
import { cors } from 'hono/cors'
import { mountOperations, onError } from './http/router'
import type { AppEnv } from './http/types'
import { operations } from './operations'

const app = new Hono<AppEnv>()

app.get('/', (c) => c.json({ message: 'Hello from xstate' }))

app.get('/health', (c) => c.json({ ok: true, service: 'api', time: new Date().toISOString() }))

const v1 = new Hono<AppEnv>()
// The sign-up and onboarding pages on xstate.com call the API from the browser.
v1.use('*', (c, next) =>
  cors({
    origin: (origin) => (c.env.APP_ORIGINS.split(',').includes(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    maxAge: 600,
  })(c, next),
)
mountOperations(v1, operations)
app.route('/v1', v1)

// Stalwart calls this when mail arrives in any account (signed; not part of the public /v1 API).
app.post('/webhooks/stalwart', handleStalwartWebhook)

app.onError(onError)
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404))

export default {
  fetch: app.fetch,
  // MAIL_SYNC jobs: copy a mailbox's new attachments to R2 (from the webhook or the hourly check).
  queue: (batch, env) => consume(batch, env),
  // Hourly: safety-net mail sync in case webhooks were lost, and purge of files deleted over 30 days ago.
  scheduled: (_controller, env, ctx) => ctx.waitUntil(hourly(env)),
} satisfies ExportedHandler<Env, MailSyncJob>
