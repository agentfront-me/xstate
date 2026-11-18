// MTA-STS (RFC 8461) for domains whose mail the store holds: senders that support it (Gmail among them) fetch
// https://mta-sts.<domain>/.well-known/mta-sts.txt and then deliver only over verified TLS to the MX hosts it lists,
// here Amazon SES receiving. Served by this Worker on a custom-domain route per domain (wrangler.jsonc), with a
// `_mta-sts` TXT record whose id changes whenever the policy does. Domains still on Stalwart, or in the middle of a
// switch (their MX may still be Stalwart), get no policy. No imports, so `pnpm test` runs it under Node.

const PATH = '/.well-known/mta-sts.txt'
const HOST_PREFIX = 'mta-sts.'
/** A week: long enough to protect, short enough that a later MX change isn't held up for long. */
export const MTA_STS_MAX_AGE = 604800

/** The policy text: enforce, SES receiving for the region as the only MX. */
export function mtaStsPolicy(region: string): string {
  return `version: STSv1\nmode: enforce\nmx: inbound-smtp.${region}.amazonaws.com\nmax_age: ${MTA_STS_MAX_AGE}\n`
}

/** The domain an MTA-STS policy host serves (mta-sts.example.com → example.com), or null for any other host. */
export function policyDomain(hostname: string): string | null {
  const host = hostname.toLowerCase()
  return host.startsWith(HOST_PREFIX) && host.length > HOST_PREFIX.length ? host.slice(HOST_PREFIX.length) : null
}

/** Answers requests to an mta-sts.<domain> host; null for every other host, so the API handles those. */
export function handleMtaStsHost(request: Request, env: Pick<Env, 'DB' | 'AWS_SES_REGION'>): Promise<Response> | null {
  const url = new URL(request.url)
  const domain = policyDomain(url.hostname)
  if (!domain) return null
  return (async () => {
    if (request.method !== 'GET' || url.pathname !== PATH) return new Response('Not found', { status: 404 })
    const path = await env.DB.prepare('SELECT mail_path FROM domains WHERE name = ?').bind(domain).first<string>('mail_path')
    if (path !== 'store') return new Response('Not found', { status: 404 })
    return new Response(mtaStsPolicy(env.AWS_SES_REGION), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    })
  })()
}
