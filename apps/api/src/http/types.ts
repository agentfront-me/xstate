import type { TokenAuth } from '../auth/api-tokens'
import type { Actor } from '../auth/types'

/**
 * Hono env for the API. `actor` is set by requireAuth on authenticated routes; requireToken sets it too, along with
 * `token`, on the routes that take a personal API token.
 */
export type AppEnv = { Bindings: Env; Variables: { actor: Actor; token: TokenAuth['token'] } }
