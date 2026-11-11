// Virus scanning for files that reach xstate through the API (composer uploads, Storage uploads and saves).
// Mail arriving over SMTP is scanned on the mail server itself, before Stalwart accepts it; both use the scan
// service in apps/scanner, which runs ClamAV next to Stalwart.
//
// SCAN_MODE picks what happens:
//   "live"  files go to SCAN_URL; an infected file is refused, and so is any file while the scanner can't be reached
//   "log"   files are scanned and results logged, but nothing is ever refused (the first week of a rollout)
//   "fake"  no scanner: only the EICAR test file counts as a virus (local dev and tests)
//   "off"   nothing is scanned
// The file-type rules in ./attachments are separate and always on.
//
// No imports, so it also runs under Node for the tests; ./refuse turns its results into API errors.

export type ScanEnv = Pick<Env, 'SCAN_MODE' | 'SCAN_URL'> & { SCAN_SECRET?: string }
export type ScanResult = { infected: false } | { infected: true; virus: string }
type Mode = 'live' | 'log' | 'fake' | 'off'

const CLEAN: ScanResult = { infected: false }
/** A scan of a large file takes seconds; past this the scanner counts as unreachable. */
const TIMEOUT_MS = 120_000

export function scanMode(env: Pick<Env, 'SCAN_MODE'>): Mode {
  const value = (env.SCAN_MODE as string | undefined) ?? 'off'
  return value === 'live' || value === 'log' || value === 'fake' ? value : 'off'
}

export const scanning = (env: Pick<Env, 'SCAN_MODE'>) => scanMode(env) !== 'off'

/** The scanner couldn't be reached in "live" mode: the file must not be stored. */
export class ScanUnavailable extends Error {
  override name = 'ScanUnavailable'
}

/**
 * Scans a file. Returns the verdict; throws ScanUnavailable when the scanner can't be reached in "live" mode,
 * so nothing is stored unscanned.
 */
export async function scanFile(env: ScanEnv, body: ReadableStream<Uint8Array> | Uint8Array, name: string): Promise<ScanResult> {
  const mode = scanMode(env)
  if (mode === 'off') {
    if (body instanceof ReadableStream) await body.cancel().catch(() => null)
    return CLEAN
  }
  if (mode === 'fake') {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())
    return hasEicar(bytes) ? { infected: true, virus: 'Eicar-Test-Signature' } : CLEAN
  }
  try {
    const result = await callScanner(env, body, name)
    if (mode === 'log') {
      if (result.infected) console.log('scan: would be refused', JSON.stringify({ name, virus: result.virus }))
      return CLEAN
    }
    return result
  } catch (err) {
    console.error('scan: scanner unreachable', err)
    if (mode === 'log') return CLEAN
    throw new ScanUnavailable(`scanner unreachable while checking ${name}`)
  }
}

async function callScanner(env: ScanEnv, body: ReadableStream<Uint8Array> | Uint8Array, name: string): Promise<ScanResult> {
  if (!env.SCAN_URL || !env.SCAN_SECRET) throw new Error('SCAN_URL and SCAN_SECRET are not set')
  const url = new URL(`${env.SCAN_URL.replace(/\/$/, '')}/scan`)
  url.searchParams.set('name', name)
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SCAN_SECRET}`, 'Content-Type': 'application/octet-stream' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // Node (tests) needs this to send a stream; Workers ignore it.
    ...(body instanceof ReadableStream && { duplex: 'half' }),
  } as RequestInit)
  if (!res.ok) throw new Error(`scanner answered HTTP ${res.status}`)
  const result = (await res.json()) as { infected?: boolean; virus?: string }
  return result.infected ? { infected: true, virus: result.virus || 'unknown' } : CLEAN
}

/** What the scanner says about itself (GET /health), for the hourly check. Null when scanning is off or faked. */
export async function scannerHealth(env: ScanEnv): Promise<{ ok: boolean; detail: string } | null> {
  const mode = scanMode(env)
  if (mode !== 'live' && mode !== 'log') return null
  if (!env.SCAN_URL) return { ok: false, detail: 'SCAN_URL is not set' }
  try {
    const res = await fetch(`${env.SCAN_URL.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(15_000) })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ageHours?: number | null; clamav?: string }
    if (res.ok && body.ok) return { ok: true, detail: `${body.clamav}, signatures ${body.ageHours} h old` }
    return { ok: false, detail: body.error ?? `signatures are ${body.ageHours ?? '?'} h old (HTTP ${res.status})` }
  } catch (err) {
    return { ok: false, detail: `unreachable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// The EICAR test file: harmless, and every antivirus reports it. In two halves so this source isn't one itself.
const EICAR = new TextEncoder().encode('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')

export function hasEicar(bytes: Uint8Array): boolean {
  outer: for (let i = 0; i + EICAR.length <= bytes.length; i++) {
    if (bytes[i] !== EICAR[0]) continue
    for (let j = 1; j < EICAR.length; j++) if (bytes[i + j] !== EICAR[j]) continue outer
    return true
  }
  return false
}
