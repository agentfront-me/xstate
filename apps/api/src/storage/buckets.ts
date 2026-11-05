// Organization buckets, through the Cloudflare API (R2 bucket management isn't part of the S3 API we use for
// objects). Needs CLOUDFLARE_API_TOKEN with "Workers R2 Storage Write" on the account.

import * as organizationsDb from '../db/organizations'
import { ApiError } from '../errors'
import { deletePrefix, type R2Env } from './r2'

export type BucketEnv = R2Env & Pick<Env, 'DB' | 'CLOUDFLARE_API_TOKEN' | 'ENVIRONMENT' | 'APP_ORIGINS'>

/** Near the mail server (us-east-2) and the main users; R2 picks the closest region in Eastern North America. */
const LOCATION_HINT = 'enam'

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
  if (!env.CLOUDFLARE_API_TOKEN || !env.R2_ACCESS_KEY_ID || !organizationIds.length) return
  waitUntil(
    (async () => {
      for (const id of organizationIds) {
        if (await organizationsDb.getBucket(env.DB, id)) continue
        await organizationBucket(env, id).catch((err) => console.error(`storage: creating bucket for ${id} failed`, err))
      }
    })(),
  )
}
