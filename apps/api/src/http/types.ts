import type { Actor } from '../auth/types'

/** Hono env for the API. `actor` is set by requireAuth on authenticated routes. */
export type AppEnv = { Bindings: Env; Variables: { actor: Actor } }
