// R2 through its S3-compatible API. Organization buckets are created at runtime, and a Worker binding has to be
// declared in wrangler.jsonc before deploy, so the API reaches them with an account-wide R2 access key instead.
// Requests are signed with aws4fetch. Objects never pass through here on their way to or from a browser: the
// browser gets a short-lived presigned URL instead (presign below).

import { AwsClient } from 'aws4fetch'
import { ApiError } from '../errors'

export type R2Env = Pick<Env, 'CLOUDFLARE_ACCOUNT_ID' | 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY'>

let client: { key: string; aws: AwsClient } | null = null

function aws(env: R2Env): AwsClient {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new ApiError('storage_not_configured', 'File storage is not set up on this server', 503)
  }
  if (client?.key !== env.R2_ACCESS_KEY_ID) {
    client = {
      key: env.R2_ACCESS_KEY_ID,
      aws: new AwsClient({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        service: 's3',
        region: 'auto',
      }),
    }
  }
  return client.aws
}

/** The object's URL. Each path segment is encoded, so names with spaces or unicode work. */
export function objectUrl(env: R2Env, bucket: string, key = ''): URL {
  const path = key.split('/').map(encodeURIComponent).join('/')
  return new URL(`https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${path}`)
}

async function send(env: R2Env, url: URL, init: RequestInit = {}): Promise<Response> {
  const res = await aws(env).fetch(url.toString(), init)
  if (res.ok || res.status === 404) return res
  throw new ApiError('storage_error', `File storage returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, 502)
}

/** Writes an object. `body` may be a stream, in which case `size` must be given (R2 needs Content-Length). */
export async function putObject(
  env: R2Env,
  bucket: string,
  key: string,
  body: ReadableStream | ArrayBuffer | Uint8Array | string,
  options: { contentType: string; size?: number; metadata?: Record<string, string> },
): Promise<void> {
  const headers = new Headers({ 'Content-Type': options.contentType })
  if (options.size !== undefined) headers.set('Content-Length', String(options.size))
  for (const [name, value] of Object.entries(options.metadata ?? {})) headers.set(`x-amz-meta-${name}`, value)
  // Streams can't be hashed up front; R2 accepts the standard "unsigned payload" marker for them.
  if (body instanceof ReadableStream) headers.set('x-amz-content-sha256', 'UNSIGNED-PAYLOAD')
  await send(env, objectUrl(env, bucket, key), { method: 'PUT', headers, body })
}

/** The object, or null if it doesn't exist. */
export async function getObject(env: R2Env, bucket: string, key: string): Promise<Response | null> {
  const res = await send(env, objectUrl(env, bucket, key))
  return res.status === 404 ? null : res
}

/** Size and type, or null if it doesn't exist. */
export async function headObject(env: R2Env, bucket: string, key: string) {
  const res = await send(env, objectUrl(env, bucket, key), { method: 'HEAD' })
  if (res.status === 404) return null
  return { size: Number(res.headers.get('Content-Length') ?? 0), contentType: res.headers.get('Content-Type') ?? '' }
}

/**
 * Copies an object inside R2, without the bytes passing through the Worker. Returns false if the source is missing.
 * Copies within one bucket only (the organization's).
 */
export async function copyObject(env: R2Env, bucket: string, fromKey: string, toKey: string): Promise<boolean> {
  const source = `/${bucket}/${fromKey.split('/').map(encodeURIComponent).join('/')}`
  const res = await send(env, objectUrl(env, bucket, toKey), {
    method: 'PUT',
    headers: { 'x-amz-copy-source': source, 'x-amz-metadata-directive': 'COPY' },
  })
  return res.status !== 404
}

/** Deletes an object. Deleting one that doesn't exist is fine. */
export async function deleteObject(env: R2Env, bucket: string, key: string): Promise<void> {
  await send(env, objectUrl(env, bucket, key), { method: 'DELETE' })
}

/** Keys under a prefix, up to 1,000 per page. */
export async function listKeys(env: R2Env, bucket: string, prefix: string, continuationToken?: string) {
  const url = objectUrl(env, bucket)
  url.searchParams.set('list-type', '2')
  url.searchParams.set('prefix', prefix)
  if (continuationToken) url.searchParams.set('continuation-token', continuationToken)
  const xml = await (await send(env, url)).text()
  const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => decodeXml(m[1]!))
  const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1]
  return { keys, next: next ? decodeXml(next) : null }
}

/** Deletes every object under a prefix (a mailbox's folder), or the whole bucket with prefix ''. */
export async function deletePrefix(env: R2Env, bucket: string, prefix: string): Promise<number> {
  let deleted = 0
  let token: string | undefined
  do {
    const page = await listKeys(env, bucket, prefix, token)
    // Small batches in parallel; R2 has no rate limit on deletes of different keys.
    for (let i = 0; i < page.keys.length; i += 25) {
      await Promise.all(page.keys.slice(i, i + 25).map((key) => deleteObject(env, bucket, key)))
    }
    deleted += page.keys.length
    token = page.next ?? undefined
  } while (token)
  return deleted
}

/**
 * A URL that lets whoever holds it GET or PUT one object until it expires. Issued only after the API has checked
 * access. Downloads are always served as attachments, never rendered by the browser.
 */
export async function presign(
  env: R2Env,
  bucket: string,
  key: string,
  options: { method: 'GET' | 'PUT'; expiresIn: number; fileName?: string; contentType?: string },
): Promise<string> {
  const url = objectUrl(env, bucket, key)
  url.searchParams.set('X-Amz-Expires', String(options.expiresIn))
  if (options.method === 'GET' && options.fileName) {
    url.searchParams.set('response-content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(options.fileName)}`)
  }
  const headers: Record<string, string> = {}
  if (options.method === 'PUT' && options.contentType) headers['Content-Type'] = options.contentType
  const signed = await aws(env).sign(url.toString(), { method: options.method, headers, aws: { signQuery: true } })
  return signed.url
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
