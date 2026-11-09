// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { afterEach, describe, it } from 'node:test'
import { accessToken, GoogleError } from './auth.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const keyFile = JSON.stringify({
  client_email: 'xstate-migration@example.iam.gserviceaccount.com',
  client_id: '123456789',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
})
const env = { GOOGLE_MIGRATION_KEY: keyFile }
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString())

describe('accessToken', () => {
  it('sends a JWT signed with the service account key, for the user and scopes asked', async () => {
    let assertion = ''
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      assertion = new URLSearchParams(String(init.body)).get('assertion') ?? ''
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 })
    }) as typeof fetch
    const token = await accessToken(env, 'admin@acme.test', ['scope-a', 'scope-b'])
    assert.equal(token, 'tok-1')

    const [header, claims, signature] = assertion.split('.')
    assert.deepEqual(decode(header!), { alg: 'RS256', typ: 'JWT' })
    const c = decode(claims!)
    assert.equal(c.iss, 'xstate-migration@example.iam.gserviceaccount.com')
    assert.equal(c.sub, 'admin@acme.test')
    assert.equal(c.scope, 'scope-a scope-b')
    assert.equal(c.aud, 'https://oauth2.googleapis.com/token')
    assert.equal(c.exp - c.iat, 3600)
    const ok = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, 'base64url'))
    assert.ok(ok, 'signature verifies with the public key')
  })

  it('reuses a cached token', async () => {
    globalThis.fetch = (async () => {
      throw new Error('should not be called')
    }) as typeof fetch
    assert.equal(await accessToken(env, 'admin@acme.test', ['scope-a', 'scope-b']), 'tok-1')
  })

  it('reports missing delegation and unknown users as distinct errors', async () => {
    const reply = (error: string) =>
      (async () => new Response(JSON.stringify({ error, error_description: 'x' }), { status: 401 })) as unknown as typeof fetch
    globalThis.fetch = reply('unauthorized_client')
    await assert.rejects(accessToken(env, 'a@acme.test', ['s']), (e: GoogleError) => e.code === 'not_authorized')
    globalThis.fetch = reply('invalid_grant')
    await assert.rejects(accessToken(env, 'b@acme.test', ['s']), (e: GoogleError) => e.code === 'no_such_user')
  })

  it('says when no key is configured', async () => {
    await assert.rejects(accessToken({}, 'a@acme.test', ['s']), (e: GoogleError) => e.code === 'not_configured')
  })
})
