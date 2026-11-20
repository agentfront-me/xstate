// Phase 0 test: mail app (this script) → bridge (TLS) → Worker → ImapSession. Locally: the `api-relay` dev server and
// the bridge on 127.0.0.1:1993. LOGIN is "<mailbox address> <app password>" (create one in Settings → App passwords).
import tls from 'node:tls'
const PORT = Number(process.env.PORT ?? 1993), API = process.env.API ?? 'http://localhost:8826'
const SECRET = process.env.SECRET ?? 'local-relay-secret', LOGIN = process.env.LOGIN ?? 'spike@xstate.test local-spike-password'
const IDLE_SECS = Number(process.env.IDLE_SECS ?? 25), BLOB = Number(process.env.BLOB ?? 30 * 1024 * 1024)
const HOST = process.env.HOST ?? 'localhost'
const sock = tls.connect({ host: HOST, port: PORT, rejectUnauthorized: HOST !== 'localhost', servername: HOST })
let buf = '', bytes = 0, counting = false
sock.on('data', (d) => { bytes += d.length; if (!counting) buf += d.toString('latin1') })
const until = async (re, ms = 20000) => { const t = Date.now(); for (;;) { const m = re.exec(buf); if (m) { const out = buf.slice(0, m.index + m[0].length); buf = buf.slice(m.index + m[0].length); return out } if (Date.now() - t > ms) throw new Error(`timeout waiting for ${re}; have: ${buf.slice(-200)}`); await new Promise((r) => setTimeout(r, 20)) } }
const cmd = async (tag, text) => { sock.write(`${tag} ${text}\r\n`); return until(new RegExp(`^${tag} (OK|NO|BAD)[^\\r]*\\r\\n`, 'm')) }
const poke = (id, peek) => fetch(`${API}/relay/poke/${id}${peek ? '?peek=1' : ''}`, { method: 'POST', headers: { 'X-Relay-Secret': SECRET } }).then((r) => r.json())
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000))
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) process.exitCode = 1 }

console.log((await until(/\* OK[^\r]*\r\n/)).trim())
check('bad login refused', /NO \[AUTHENTICATIONFAILED\]/.test(await cmd('a0', 'LOGIN nobody@x.test wrong')))
check('login', /a1 OK/.test(await cmd('a1', `LOGIN ${LOGIN}`)))
check('select', /5000 EXISTS[\s\S]*READ-ONLY/.test(await cmd('a2', 'SELECT INBOX')))
const st1 = await cmd('a3', 'XSTATE'); const id = /id=(\w+)/.exec(st1)[1]
console.log('  ' + st1.split('\r\n')[0])
sock.write('a4 IDLE\r\n'); await until(/\+ idling\r\n/)
console.log(`  idling ${IDLE_SECS}s (the session should hibernate after ~10s)`)
await sleep(IDLE_SECS)
const told = await poke(id)
check('store-style call reaches the idle session', told.told === true)
check('mail app is told of new mail while idle', /\* 5001 EXISTS/.test(await until(/EXISTS\r\n/, 5000)))
sock.write('DONE\r\n'); await until(/a4 OK[^\r]*\r\n/)
const st2 = await cmd('a5', 'XSTATE'); console.log('  ' + st2.split('\r\n')[0])
const n = (k, s) => Number(new RegExp(`${k}=(\\d+)`).exec(s)[1])
check('memory was reset while idle (hibernated)', n('in-memory', st2) < n('commands', st2), `in-memory=${n('in-memory', st2)} commands=${n('commands', st2)}`)
check('UID list survived in storage', n('uids', st2) === 5001 && n('last-uid', st2) === 15003)
// Flow control: stop reading, ask for a big download, and look at the session from outside.
sock.pause(); sock.write(`a6 XBLOB ${BLOB}\r\n`); await sleep(6)
const held = (await poke(id, true)).state
check('download waits while the mail app reads nothing', held.blobLeft > 0 && held.sent - held.acked <= 1024 * 1024 + 65536, `sent-acked=${held.sent - held.acked} left=${held.blobLeft}`)
counting = true; const before = bytes, t0 = Date.now(); sock.resume()
while (bytes - before < BLOB) { if (Date.now() - t0 > 120000) throw new Error(`download stalled at ${bytes - before}`); await sleep(0.05) }
await sleep(0.5); counting = false
check('whole download arrives', bytes - before >= BLOB, `${((bytes - before) / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
buf = ''
check('session still answers after the download', /a7 OK/.test(await cmd('a7', 'NOOP')))
check('logout closes the connection', /BYE[\s\S]*a8 OK/.test(await cmd('a8', 'LOGOUT')))
await new Promise((r) => { sock.on('close', r); setTimeout(r, 5000) })
await sleep(1)
const after = await poke(id, true)
check('session forgotten after close', after.state === null)
