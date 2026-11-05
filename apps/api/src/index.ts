import { Hono } from 'hono'
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

app.onError(onError)
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404))

export default app
