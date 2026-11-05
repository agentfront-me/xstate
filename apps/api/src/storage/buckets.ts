// Organization buckets, through the Cloudflare API (R2 bucket management isn't part of the S3 API we use for
// objects). Needs CLOUDFLARE_API_TOKEN with "Workers R2 Storage Write" on the account.

import * as organizationsDb from '../db/organizations'
import { ApiError } from '../errors'
import { deletePrefix, type R2Env } from './r2'

export type BucketEnv = R2Env & Pick<Env, 'DB' | 'CLOUDFLARE_API_TOKEN' | 'ENVIRONMENT' | 'APP_ORIGINS' | 'R2_BUCKET'>

/** Near the mail server (us-east-2) and the main users; R2 picks the closest region in Eastern North America. */
const LOCATION_HINT = 'enam'

/**
 * Whether file storage is set up: R2 keys for objects, plus either a Cloudflare API token to create a bucket per
 * organization (production) or a shared R2_BUCKET (local dev). Without them, file features answer 503
 * storage_not_configured.
 */
export function storageConfigured(
  env: Pick<Env, 'CLOUDFLARE_API_TOKEN' | 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'R2_BUCKET' | 'ENVIRONMENT'>,
): boolean {
  return !!(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && (env.CLOUDFLARE_API_TOKEN || sharedBucket(env)))
}

/**
 * Local dev: the one bucket every organization shares (R2_BUCKET, e.g. xstate-dev), or null for a bucket per
 * organization. Never used in production. Sharing is safe because files live under `<mailboxId>/` and mailbox ids
 * are unique, and deleting a mailbox only removes its own folder.
 */
export function sharedBucket(env: Pick<Env, 'R2_BUCKET' | 'ENVIRONMENT'>): string | null {
  const name = (env.R2_BUCKET as string).trim()
  return name && (env.ENVIRONMENT as string) !== 'production' ? name : null
}

/** `xstate-org-<id>` in production, `xstate-dev-org-<id>` otherwise, so local runs never touch customer buckets. */
export function bucketName(env: Pick<Env, 'ENVIRONMENT'>, organizationId: string): string {
  const prefix = env.ENVIRONMENT === 'production' ? 'xstate-org-' : 'xstate-dev-org-'
  return `${prefix}${organizationId.toLowerCase()}`
}

async function cloudflare(env: BucketEnv, method: string, path: string, body?: unknown) {
  if (!env.CLOUDFLARE_API_TOKEN) throw new ApiError('storage_not_configured', 'File storage is not set up on this server', 503)
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { code: number; message: string }[] }
  return { ok: res.ok && data.success !== false, status: res.status, errors: data.errors ?? [] }
}

/**
 * Creates the bucket (or finds it already there) and sets CORS so the dashboard and desktop app can upload and
 * download directly with presigned URLs.
 */
export async function createBucket(env: BucketEnv, name: string): Promise<void> {
  const created = await cloudflare(env, 'POST', '', { name, locationHint: LOCATION_HINT, storageClass: 'Standard' })
  // 409: it already exists and we own it (a previous attempt got this far). That's the outcome we wanted.
  if (!created.ok && created.status !== 409) {
    throw new ApiError('storage_error', `Couldn't create bucket ${name}: ${describe(created.errors)}`, 502)
  }
  const origins = env.APP_ORIGINS.split(',').filter((o) => /^https?:\/\//.test(o))
  const cors = await cloudflare(env, 'PUT', `/${name}/cors`, {
    rules: [
      {
        id: 'xstate-app',
        allowed: { origins, methods: ['GET', 'PUT', 'HEAD'], headers: ['content-type'] },
        exposeHeaders: ['ETag', 'Content-Length', 'Content-Disposition'],
        maxAgeSeconds: 3600,
      },
    ],
  })
  if (!cors.ok) throw new ApiError('storage_error', `Couldn't set CORS on bucket ${name}: ${describe(cors.errors)}`, 502)
}

/** Empties the bucket, then deletes it (R2 only deletes empty buckets). */
export async function destroyBucket(env: BucketEnv, name: string): Promise<void> {
  await deletePrefix(env, name, '')
  const res = await cloudflare(env, 'DELETE', `/${name}`)
  if (!res.ok && res.status !== 404) throw new ApiError('storage_error', `Couldn't delete bucket ${name}: ${describe(res.errors)}`, 502)
}

/**
 * The organization's bucket name, creating the bucket first if it doesn't exist yet. Sign-up tries to create it
 * straight away; if that failed, the first file stored creates it here instead.
 */
export async function organizationBucket(env: BucketEnv, organizationId: string): Promise<string> {
  const existing = await organizationsDb.getBucket(env.DB, organizationId)
  const shared = sharedBucket(env)
  if (shared) {
    // Never created here: it already exists, and the local token can't create buckets anyway.
    if (existing !== shared) await organizationsDb.setBucket(env.DB, organizationId, shared).run()
    return shared
  }
  if (existing) return existing
  const name = bucketName(env, organizationId)
  await createBucket(env, name)
  await organizationsDb.setBucket(env.DB, organizationId, name).run()
  return name
}

function describe(errors: { code: number; message: string }[]): string {
  return errors.map((e) => `${e.message} (${e.code})`).join('; ') || 'unknown error'
}

/**
 * Makes sure each organization has its bucket, after the response is sent. Failures are logged, not thrown: the
 * next sign-in or the first stored file tries again. Does nothing when storage isn't configured (local dev
 * without R2 credentials).
 */
export function ensureBucketsInBackground(
  env: BucketEnv,
  waitUntil: (promise: Promise<unknown>) => void,
  organizationIds: string[],
): void {
  if (!storageConfigured(env) || !organizationIds.length) return
  waitUntil(
    (async () => {
      for (const id of organizationIds) {
        if (await organizationsDb.getBucket(env.DB, id)) continue
        await organizationBucket(env, id).catch((err) => console.error(`storage: creating bucket for ${id} failed`, err))
      }
    })(),
  )
}
