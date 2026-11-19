// Growth's searchable-mail cap (internal, never on the pricing page; docs/pricing-plan.md §8a): 100 emails per person
// of the paid Growth size, so 500,000 at 5,000. Over it, the emails indexed longest ago leave AI search: their vectors
// and search_docs rows are removed. The mail itself stays, listed and readable. Run from the hourly limits pass, at
// most TRIM_PER_RUN emails an hour per organization so a big import catches up over a few hours.
//
// "Longest ago" is by indexed_at: search_docs keeps no email date, so mail imported recently counts as recent.

import { removeDocument } from '../search/indexer'
import type { DocRow } from '../db/search'

export const TRIM_PER_RUN = 2000

const EMAIL_DOCS = "organization_id = ? AND status = 'indexed' AND doc_id LIKE 'email:%'"

export async function trimSearchable(env: Env, organizationId: string, cap: number | null): Promise<number> {
  if (cap === null) return 0
  const count = await env.DB.prepare(`SELECT count(*) AS n FROM search_docs WHERE ${EMAIL_DOCS}`).bind(organizationId).first<{ n: number }>()
  const over = (count?.n ?? 0) - cap
  if (over <= 0) return 0
  const { results } = await env.DB.prepare(`SELECT * FROM search_docs WHERE ${EMAIL_DOCS} ORDER BY indexed_at LIMIT ?`)
    .bind(organizationId, Math.min(over, TRIM_PER_RUN))
    .all<DocRow>()
  let removed = 0
  for (const row of results) {
    try {
      await removeDocument(env, row)
      removed++
    } catch (err) {
      console.error('limits: search trim failed', organizationId, row.doc_id, err)
    }
  }
  if (removed) console.log('limits: search cap', JSON.stringify({ organizationId, cap, over, removed }))
  return removed
}
