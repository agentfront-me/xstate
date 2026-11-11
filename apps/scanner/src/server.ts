// The scan service's HTTP side. Three routes:
//   POST /hook          Stalwart's MTA hook: one email as JSON, answered with accept or reject (message.ts)
//   POST /scan?name=    the API: one file as the request body, answered with { infected, virus }
//   GET  /health        whether ClamAV is up and how old its signatures are (no secret needed; says nothing else)
// /hook and /scan need "Authorization: Bearer <SCAN_SECRET>". Stalwart calls on localhost; the API comes in
// through nginx over HTTPS.
//
// SCAN_ENFORCE=false is the log-only mode for rolling out: everything is scanned and logged, nothing is refused.

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Clamd } from './clamd.ts'
import { hookResponse, judge, rawMessage, type HookRequest } from './message.ts'

export type Options = {
  clam: Clamd
  secret: string
  /** False: log what would be refused, refuse nothing. */
  enforce: boolean
  /** The scanner is the fake one (local dev, tests). */
  fake?: boolean
  /** Largest hook request (a whole email as JSON) and largest file, in bytes. */
  maxBytes?: number
  log?: (line: Record<string, unknown>) => void
}

/** Signatures older than this make /health fail: freshclam has stopped updating. */
const STALE_HOURS = 48

export function scanServer(options: Options): Server {
  const { clam, secret, enforce } = options
  const maxBytes = options.maxBytes ?? 120 * 1024 * 1024
  const log = options.log ?? ((line) => console.log(JSON.stringify({ at: new Date().toISOString(), ...line })))
  const counts = { messages: 0, files: 0, refused: 0, errors: 0 }
  const started = Date.now()

  const authorized = (req: IncomingMessage) => {
    const given = Buffer.from(req.headers.authorization ?? '')
    const wanted = Buffer.from(`Bearer ${secret}`)
    return given.length === wanted.length && timingSafeEqual(given, wanted)
  }

  async function hook(req: IncomingMessage, res: ServerResponse) {
    const body = JSON.parse(Buffer.concat(await readAll(req, maxBytes)).toString('utf8')) as HookRequest
    if (!body.message) return json(res, 200, { action: 'accept' }) // not the DATA stage: nothing to scan
    counts.messages++
    const verdict = await judge(rawMessage(body.message), clam, options.fake)
    const about = {
      from: body.envelope?.from?.address,
      to: body.envelope?.to?.map((t) => t.address),
      ip: body.context?.client?.ip,
      login: body.context?.sasl?.login,
      queue: body.context?.queue?.id,
      size: body.message.size,
    }
    if (verdict.ok) return json(res, 200, { action: 'accept' })
    counts.refused++
    log({ event: enforce ? 'message-refused' : 'message-would-be-refused', ...verdict, ...about })
    json(res, 200, enforce ? hookResponse(verdict) : { action: 'accept' })
  }

  async function scan(req: IncomingMessage, res: ServerResponse, name: string) {
    counts.files++
    const result = await clam.scan(limited(req, maxBytes))
    if (result.infected) {
      counts.refused++
      log({ event: enforce ? 'file-refused' : 'file-would-be-refused', name, virus: result.virus })
    }
    json(res, 200, enforce ? result : { infected: false })
  }

  async function health(res: ServerResponse) {
    try {
      await clam.ping()
      const { version, signatures } = await clam.version()
      const ageHours = signatures ? Math.round((Date.now() - signatures.getTime()) / 3_600_000) : null
      const ok = ageHours !== null && ageHours <= STALE_HOURS
      json(res, ok ? 200 : 503, { ok, enforce, clamav: version, signatures: signatures?.toISOString() ?? null, ageHours, counts, upSeconds: Math.round((Date.now() - started) / 1000) })
    } catch (err) {
      json(res, 503, { ok: false, enforce, error: String(err instanceof Error ? err.message : err) })
    }
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://scanner')
    const route = `${req.method} ${url.pathname}`
    void (async () => {
      if (route === 'GET /health') return health(res)
      if (route !== 'POST /hook' && route !== 'POST /scan') return json(res, 404, { error: 'not_found' })
      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })
      if (route === 'POST /hook') return hook(req, res)
      return scan(req, res, url.searchParams.get('name') ?? 'file')
    })().catch((err) => {
      // A failed scan is an error, never "clean": Stalwart then answers 451 (try again later) and the API 503.
      counts.errors++
      log({ event: 'error', route, error: String(err instanceof Error ? err.message : err) })
      if (!res.headersSent) json(res, err instanceof TooLarge ? 413 : 500, { error: err instanceof TooLarge ? 'too_large' : 'scan_failed' })
      else res.destroy()
    })
  })
}

class TooLarge extends Error {}

async function* limited(req: IncomingMessage, maxBytes: number): AsyncIterable<Uint8Array> {
  let total = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.byteLength
    if (total > maxBytes) throw new TooLarge('request too large')
    yield chunk
  }
}

async function readAll(req: IncomingMessage, maxBytes: number): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  for await (const chunk of limited(req, maxBytes)) chunks.push(chunk)
  return chunks
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}
