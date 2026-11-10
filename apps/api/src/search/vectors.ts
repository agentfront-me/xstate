// The Vectorize side of Storage search: embeddings, and writing and deleting a document's vectors.
//
// One namespace per organization (its id), so a query can never cross organizations whatever its filter says.
// Vector ids are `<doc id>:<chunk>`; the metadata carries the passage and the coarse scope search filters on.

export const EMBEDDING_MODEL = '@cf/baai/bge-m3'
/** Texts per Workers AI call. */
const EMBED_BATCH = 100
/** Vectorize limits: 1,000 vectors per upsert from a Worker, 100 ids per delete. */
const UPSERT_BATCH = 1000
const DELETE_BATCH = 100

export type VectorEnv = Pick<Env, 'AI' | 'SEARCH' | 'SEARCH_DEV' | 'ENVIRONMENT'>

/** Where a document lives, for the filters search applies before the permission check. */
export type Scope = {
  /** Top-level Storage item id, or `mb:<mailbox id>` for mail. */
  top: string
  space: 'personal' | 'organization' | 'mail'
  /** For My Files: the member whose My Files it is in. Empty otherwise. */
  owner: string
}

/** Emails carry their headline too, so a result needs no call to the mail server. */
export type DocMetadata = { title?: string; from?: string; at?: string; thread?: string }

export type ChunkMetadata = Scope & DocMetadata & { doc: string; text: string; pos: string }

/** Production vectors live in SEARCH; wrangler dev has no Vectorize simulator and uses the remote dev index. */
export function index(env: VectorEnv): VectorizeIndex {
  return env.ENVIRONMENT === 'production' ? env.SEARCH : env.SEARCH_DEV
}

export async function embed(env: Pick<Env, 'AI'>, texts: string[]): Promise<number[][]> {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const result = await env.AI.run(EMBEDDING_MODEL, { text: texts.slice(i, i + EMBED_BATCH), truncate_inputs: true })
    if (!('data' in result) || !result.data) throw new Error('embedding: no data in the model response')
    out.push(...result.data)
  }
  return out
}

/** Hits per query: Vectorize's most with metadata returned. */
export const TOP_K = 50

export type Hit = { id: string; score: number; metadata: ChunkMetadata }

/** The nearest passages in the organization's namespace that match `filter`. */
export async function query(
  env: VectorEnv,
  organizationId: string,
  vector: number[],
  filter: VectorizeVectorMetadataFilter,
): Promise<Hit[]> {
  const res = await index(env).query(vector, { namespace: organizationId, topK: TOP_K, returnMetadata: 'all', filter })
  return res.matches
    .filter((m) => m.metadata && typeof m.metadata.doc === 'string' && typeof m.metadata.text === 'string')
    .map((m) => ({ id: m.id, score: m.score, metadata: m.metadata as ChunkMetadata }))
}

/** A document's passages as Vectorize rows. */
export function documentRows(
  organizationId: string,
  doc: string,
  scope: Scope,
  chunks: string[],
  vectors: number[][],
  extra: DocMetadata = {},
): VectorizeVector[] {
  return vectors.map((values, i) => ({
    id: `${doc}:${i}`,
    values,
    namespace: organizationId,
    metadata: { ...scope, ...extra, doc, text: chunks[i]!, pos: String(i) } satisfies ChunkMetadata,
  }))
}

/** Writes a document's passages, replacing vectors with the same ids. */
export async function upsertDocument(
  env: VectorEnv,
  organizationId: string,
  doc: string,
  scope: Scope,
  chunks: string[],
  vectors: number[][],
  extra: DocMetadata = {},
): Promise<void> {
  await upsertRows(env, documentRows(organizationId, doc, scope, chunks, vectors, extra))
}

/** Waits before each retry of a write Vectorize refused for rate, in ms (plus up to a second of jitter). */
const RATE_RETRY_MS = [2_000, 5_000, 10_000, 20_000]

/** Vectorize refusing a write because too many are arriving ("VECTOR_UPSERT_ERROR (code = 40041)"). */
export const isRateLimited = (err: unknown) => /40041|Too Many Requests/i.test(String(err))

/**
 * Writes rows in as few calls as Vectorize allows (UPSERT_BATCH each). A call refused for rate is retried after a
 * pause with the same vectors, so nothing is embedded twice; it throws only once the retries run out.
 */
export async function upsertRows(env: VectorEnv, rows: VectorizeVector[], wait: (ms: number) => Promise<unknown> = sleep): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH)
    for (let attempt = 0; ; attempt++) {
      try {
        await index(env).upsert(batch)
        break
      } catch (err) {
        if (!isRateLimited(err) || attempt >= RATE_RETRY_MS.length) throw err
        await wait(RATE_RETRY_MS[attempt]! + Math.random() * 1000)
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Deletes a document's vectors by id. Deleting an id that is already gone succeeds, so this is safe to repeat. */
export async function deleteDocument(env: VectorEnv, doc: string, chunks: number): Promise<void> {
  const ids = Array.from({ length: chunks }, (_, i) => `${doc}:${i}`)
  for (let i = 0; i < ids.length; i += DELETE_BATCH) await index(env).deleteByIds(ids.slice(i, i + DELETE_BATCH))
}
