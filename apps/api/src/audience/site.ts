// Which website an event belongs to. People and their visitor ids are kept per site, so a visitor who goes from the
// marketing site (acme.com) to the app (app.acme.com) stays one person. A site is the organization's own domain
// that the hostname falls under, the same rule the dashboard uses to show a domain with its subdomains. Hostnames
// outside the organization's domains are their own site. The snippet keeps its visitor id in a cookie on the top
// domain (snippet.ts), so both halves send the same id.

/** The organization's verified domains, lowercase, without www., sorted and without repeats. */
export function normalizeSites(names: string[]): string[] {
  const out = new Set<string>()
  for (const n of names) {
    const s = n.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
    if (s) out.add(s)
  }
  return [...out].sort()
}

/** The site a hostname belongs to: the longest of the organization's domains that it is or ends in, else itself. */
export function siteOf(host: string, sites: readonly string[]): string {
  let best: string | null = null
  for (const s of sites) {
    if ((host === s || host.endsWith('.' + s)) && (!best || s.length > best.length)) best = s
  }
  return best ?? host
}

/** Each organization's verified domains, kept a few minutes per isolate so collecting rarely reads the database. */
const SITES_TTL_MS = 5 * 60_000
const sitesCache = new Map<string, { at: number; sites: string[] }>()

export async function organizationSites(env: Pick<Env, 'DB'>, organizationId: string): Promise<string[]> {
  const now = Date.now()
  const hit = sitesCache.get(organizationId)
  if (hit && now - hit.at < SITES_TTL_MS) return hit.sites
  const { results } = await env.DB.prepare("SELECT name FROM domains WHERE organization_id = ? AND status = 'verified'")
    .bind(organizationId)
    .all<{ name: string }>()
  const sites = normalizeSites(results.map((r) => r.name))
  if (sitesCache.size > 1000) sitesCache.clear()
  sitesCache.set(organizationId, { at: now, sites })
  return sites
}
