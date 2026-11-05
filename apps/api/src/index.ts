import { Hono } from 'hono'
import { mountOperations, onError } from './http/router'
import type { AppEnv } from './http/types'
import { operations } from './operations'

const app = new Hono<AppEnv>()

app.get('/', (c) => c.json({ message: 'Hello from xstate' }))

app.get('/health', (c) => c.json({ ok: true, service: 'api', time: new Date().toISOString() }))

const v1 = new Hono<AppEnv>()
mountOperations(v1, operations)
app.route('/v1', v1)

app.onError(onError)
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404))

export default app
