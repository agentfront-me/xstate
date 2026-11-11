// Scans a file about to be stored and throws the API error for it when it mustn't be: 400 virus_found, or
// 503 scan_unavailable while the scanner can't be reached (see ./scan for the modes).

import { ApiError } from '../errors'
import { ScanUnavailable, scanFile, type ScanEnv } from './scan'

export async function refuseVirus(env: ScanEnv, body: ReadableStream<Uint8Array> | Uint8Array, name: string): Promise<void> {
  const result = await scanFile(env, body, name).catch((err) => {
    if (err instanceof ScanUnavailable) {
      throw new ApiError('scan_unavailable', `Couldn’t check ${name} for viruses just now. Try again in a moment.`, 503)
    }
    throw err
  })
  if (result.infected) throw new ApiError('virus_found', `${name} wasn’t uploaded: it contains a virus (${result.virus}).`, 400)
}
