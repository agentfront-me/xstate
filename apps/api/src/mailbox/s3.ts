// The S3 bucket SES saves received mail to (docs/mailbox-store-plan.md, phase 2 step 1): read once by the receiving
// consumer, then deleted. The Worker's IAM user (MAIL_INBOUND_ACCESS_KEY_ID) can only read, write (the quarantine copy)
// and delete in that bucket.

import { AwsClient } from 'aws4fetch'

export type InboundEnv = Pick<Env, 'AWS_SES_REGION'> & { MAIL_INBOUND_ACCESS_KEY_ID?: string; MAIL_INBOUND_SECRET_ACCESS_KEY?: string }

let client: { key: string; aws: AwsClient } | null = null

function aws(env: InboundEnv): AwsClient {
  if (!env.MAIL_INBOUND_ACCESS_KEY_ID || !env.MAIL_INBOUND_SECRET_ACCESS_KEY) throw new Error('Receiving is not set up: MAIL_INBOUND_* keys are missing')
  if (client?.key !== env.MAIL_INBOUND_ACCESS_KEY_ID) {
    client = {
      key: env.MAIL_INBOUND_ACCESS_KEY_ID,
      aws: new AwsClient({
        accessKeyId: env.MAIL_INBOUND_ACCESS_KEY_ID,
        secretAccessKey: env.MAIL_INBOUND_SECRET_ACCESS_KEY,
        service: 's3',
        region: env.AWS_SES_REGION,
      }),
    }
  }
  return client.aws
}

const objectUrl = (env: InboundEnv, bucket: string, key: string) =>
  `https://${bucket}.s3.${env.AWS_SES_REGION}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`

/** The raw message, or null when it is gone (already received and deleted, or expired after 7 days). */
export async function getInbound(env: InboundEnv, bucket: string, key: string): Promise<Uint8Array | null> {
  const res = await aws(env).fetch(objectUrl(env, bucket, key))
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`S3 GET ${key} failed with HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

export async function deleteInbound(env: InboundEnv, bucket: string, key: string): Promise<void> {
  const res = await aws(env).fetch(objectUrl(env, bucket, key), { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key} failed with HTTP ${res.status}`)
}

/** Moves a message under quarantine/ (a virus), where the bucket's lifecycle rule still deletes it after 7 days. */
export async function quarantineInbound(env: InboundEnv, bucket: string, key: string): Promise<string> {
  const to = `quarantine/${key.split('/').pop()}`
  const res = await aws(env).fetch(objectUrl(env, bucket, to), {
    method: 'PUT',
    headers: { 'x-amz-copy-source': `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}` },
  })
  if (!res.ok) throw new Error(`S3 copy of ${key} to quarantine failed with HTTP ${res.status}`)
  await deleteInbound(env, bucket, key)
  return to
}
