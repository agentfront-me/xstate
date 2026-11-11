// Talks to ClamAV's daemon (clamd) over its socket: INSTREAM to scan bytes, PING and VERSION for health.
//
// CLAMD says where it is: a Unix socket path ("/run/clamd.scan/clamd.sock"), "host:port" ("127.0.0.1:3310"), or
// "fake" for local dev and tests, where only the EICAR test file counts as a virus and nothing is installed.

import { connect, type Socket } from 'node:net'

export type ScanResult = { infected: false } | { infected: true; virus: string }
export type ClamVersion = { version: string; signatures: Date | null }

export type Clamd = {
  scan(data: Uint8Array | AsyncIterable<Uint8Array>): Promise<ScanResult>
  ping(): Promise<void>
  version(): Promise<ClamVersion>
}

/** clamd closes the connection when one chunk is larger than its StreamMaxLength; keep chunks small. */
const CHUNK = 64 * 1024

export function clamd(address: string, timeoutMs = 120_000): Clamd {
  if (address === 'fake') return fakeClamd()

  const open = (): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const at = address.lastIndexOf(':')
      const socket = address.startsWith('/') || at < 0 ? connect(address) : connect(Number(address.slice(at + 1)), address.slice(0, at))
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('clamd timed out')))
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })

  /** Reads clamd's whole reply (it ends the connection after one command). */
  const reply = (socket: Socket): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      socket.on('data', (c: Buffer) => chunks.push(c))
      socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()))
      socket.once('error', reject)
    })

  const write = (socket: Socket, data: Uint8Array): Promise<void> =>
    new Promise((resolve, reject) => socket.write(data, (err) => (err ? reject(err) : resolve())))

  const command = async (name: string): Promise<string> => {
    const socket = await open()
    const answer = reply(socket)
    await write(socket, Buffer.from(`z${name}\0`))
    return answer
  }

  return {
    async scan(data) {
      const socket = await open()
      const answer = reply(socket)
      // The reply can arrive (and the socket close) before everything is written, when clamd finds something or
      // hits its size limit early. Writes failing after that are expected; the reply decides.
      const send = (async () => {
        await write(socket, Buffer.from('zINSTREAM\0'))
        const parts = data instanceof Uint8Array ? [data] : data
        for await (const part of parts) {
          for (let at = 0; at < part.byteLength; at += CHUNK) {
            const chunk = part.subarray(at, at + CHUNK)
            const size = Buffer.alloc(4)
            size.writeUInt32BE(chunk.byteLength)
            await write(socket, size)
            await write(socket, chunk)
          }
        }
        await write(socket, Buffer.alloc(4))
      })().catch(() => null)
      const text = await answer
      await send
      return parseReply(text)
    },
    async ping() {
      const text = await command('PING')
      if (text !== 'PONG') throw new Error(`clamd answered ${text || 'nothing'} to PING`)
    },
    async version() {
      return parseVersion(await command('VERSION'))
    },
  }
}

/** "stream: OK", "stream: Win.Test.EICAR_HDB-1 FOUND", or an error such as "INSTREAM size limit exceeded. ERROR". */
export function parseReply(text: string): ScanResult {
  const found = /^stream: (.+) FOUND$/m.exec(text)
  if (found) return { infected: true, virus: found[1]! }
  if (/^stream: OK$/m.test(text)) return { infected: false }
  throw new Error(`clamd: ${text || 'no reply'}`)
}

/** "ClamAV 1.4.3/27812/Tue Nov 10 09:30:21 2026": the engine, the signature set and when it was built. */
export function parseVersion(text: string): ClamVersion {
  const [version = text, , built] = text.split('/')
  const date = built ? new Date(built) : null
  return { version: version.trim(), signatures: date && !Number.isNaN(date.getTime()) ? date : null }
}

// ---------------------------------------------------------------------------------------------------------------
// Fake: the EICAR test file is the only virus. Built from two halves so this source file isn't one itself.

const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')

export function hasEicar(data: Uint8Array): boolean {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).includes(EICAR)
}

function fakeClamd(): Clamd {
  return {
    async scan(data) {
      const chunks: Uint8Array[] = []
      if (data instanceof Uint8Array) chunks.push(data)
      else for await (const part of data) chunks.push(part)
      return hasEicar(Buffer.concat(chunks)) ? { infected: true, virus: 'Eicar-Test-Signature' } : { infected: false }
    },
    async ping() {},
    async version() {
      return { version: 'fake', signatures: new Date() }
    },
  }
}
