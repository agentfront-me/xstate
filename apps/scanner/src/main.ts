// xstate's scan service: runs next to Stalwart on the mail server and checks mail and files for viruses (ClamAV)
// and blocked file types. See server.ts for the routes and deploy/README.md for setting it up.
//
//   SCAN_SECRET    shared with Stalwart's MTA hook and the API (required)
//   CLAMD          clamd's socket path or host:port; "fake" for local dev (default /run/clamd.scan/clamd.sock)
//   SCAN_ENFORCE   "false" logs what would be refused and refuses nothing (default true)
//   PORT, HOST     where to listen (default 127.0.0.1:8765)

import { clamd } from './clamd.ts'
import { scanServer } from './server.ts'

const secret = process.env.SCAN_SECRET
if (!secret || secret.length < 16) {
  console.error('SCAN_SECRET must be set to a long random string (openssl rand -base64 32)')
  process.exit(1)
}
const address = process.env.CLAMD ?? '/run/clamd.scan/clamd.sock'
const enforce = process.env.SCAN_ENFORCE !== 'false'
const port = Number(process.env.PORT ?? 8765)
const host = process.env.HOST ?? '127.0.0.1'

const server = scanServer({ clam: clamd(address), secret, enforce, fake: address === 'fake' })
server.listen(port, host, () => {
  console.log(JSON.stringify({ at: new Date().toISOString(), event: 'listening', host, port, clamd: address, enforce }))
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)))
