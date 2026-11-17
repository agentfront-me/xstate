// Sender and date filters for mail search results. Vectorize has no metadata index for these (an index only covers
// vectors written after it is created, so adding one means re-embedding every message), so they are checked on the
// nearest passages after the query; search.ts asks again without the documents that didn't match. No runtime
// imports: `pnpm test` runs this file directly under Node.

export type MailFilter = {
  /** Part of the sender's address or name, any case: "waveapps.com", "jane@", "Jane Doe". */
  from?: string
  /** Received at or after, and strictly before, these ISO times. */
  after?: string
  before?: string
}

export const hasMailFilter = (f: MailFilter | undefined): f is MailFilter => !!(f && (f.from || f.after || f.before))

/** Whether a message with this sender and arrival time passes the filter. Unknown values fail a filter that needs them. */
export function matchesMail(filter: MailFilter, sender: string | null | undefined, receivedAt: string | null | undefined): boolean {
  if (filter.from) {
    if (!sender || !sender.toLowerCase().includes(filter.from.trim().toLowerCase())) return false
  }
  if (filter.after || filter.before) {
    const at = receivedAt ? Date.parse(receivedAt) : NaN
    if (Number.isNaN(at)) return false
    if (filter.after && at < Date.parse(filter.after)) return false
    if (filter.before && at >= Date.parse(filter.before)) return false
  }
  return true
}
