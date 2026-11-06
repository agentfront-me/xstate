// Unit tests for the Domain Connect signer: pnpm --filter @xstate/api test (Node's test runner, no Worker needed).
//
// The key below is a throwaway made only for these tests; it signs nothing real. The expected signature was made
// independently with OpenSSL, so the test checks our WebCrypto signing against a second implementation:
//   printf '%s' "$QUERY" | openssl dgst -sha256 -sign test.pem | base64

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { buildApplyUrl, fetchSettings, publicKeyRecords, sign, supportsTemplate } from './domain-connect.ts'

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC64citjxgzYrt2
yv9yuO9/k38klppIWcbZ5To3kBec3LJnsywFAcCw7vJ5DA7Cp90sCaoa45QC1GPF
Ax5huQWRYU7wHDAtMF91HDKg+HjGxRA1m4q6737PL+XSwQ2j2pnE/wh0Z3sMozYr
ivhLkkWlVi2rtRucPDQp/CQ0dSK4ApUCLcgSoFqaIbeScNSqBMPyUBiAAIa6Lyvg
LLCco2rSQPOpyMlE0+eZvJP85R/HbRhuDLVNsQpQBHOzZt144JDKbvc/iDT6yBtj
jdnaHln9XQ2RDVCvXXDsSQUCLxI4valvozdCewfVC8QbHLJvD7kNFae+gonuPdXk
t1m3S8KrAgMBAAECggEACWuLKZB+eEygRXcrFDXVQLmHHamHwmDgIKio3Bcj0ZDg
X1DNRb1WYLTSvR5J+i7q+6bLD8rr8Y6SLuKe2+8vJCpjB8Br/0MidK1Esg+ESwSw
8frSreSXoEr6SzrW/KzutlriqrdyoOrzNpOtO2X2o8Rpze91olT4jis7CffjlaHZ
ZFwJID3Pp3sHB/IY8Iz0c1xFGSc6BlAHVkJCao8RhuhBWdDOkQh6LQ8316y32fBO
GESSa8oQE2ozHh+xoyyXvDem18C8RRhUrWlkN6XTHC/u5kvvYAcE3r++VRNT0s2w
J6k22VahULBfdi07M6D3IQA9BI4eTdUP3WxSFt2YCQKBgQD90F2ettab1rcsdAMJ
7VzjT47fC3UtAYUyEb3GoHWRCQvHS8cW/Yjvnj5EDCa3c0jaVU2cy6G9TgkGWnw4
JQR6Rz27Plx18ZXxPXR7VTtkqlG1dYm+EVeeLevoaa8x6Wd8s2sQ+KMQxYjBqLCu
AAFxpvYzqpJsiqLS0feNzMT5QwKBgQC8fdcFV2A0/vS2rB2sJ30jwm68WQw1X7J9
DuaDApy8xDnrTk1M7eaPPzsiCKVWGwRGHJHJPi05SZCZiEeeK23SVTVqFPbk08Gf
dI5V8/hnbsidkAnRKFF3AlsDWMmUlqsmUKEw+n3n2N09ONRLWe0DoibkMDZpka+S
PmcG1eYmeQKBgAtBJAWXoeiDGtgzxLa5+bZynqkxPt7iBF/1/W5DSzNFLWqG56sT
TvEhGS23RDg6Om7D/Y8IUIGuZiQL+xoaOhqZ8hjNaRgpwDZUPUgCvYF3M+xR6+ur
pTD0ZFOH7CbQbLBQ3FyCSejCeY/sxPjSMz4w4xXjaF67vwCOIuX8wHc1AoGBAKkg
cLKGN/jVW1YdEXLK6+oOJ7YwYFfzyf+UQxkCWwi1ORL9aza/r8SQg8qB33hnPWp7
cAQWGhXxACICueAeL6gudIL+1Jl1t6IPvzc4dYa5TKC0AVr+xjn2jxttq1H77w2u
AzQjTp2dZMXuG+6Qfa5o7GSLLgeDhPm/rEnh22RhAoGAB/r2tUbHWoYAHCZgwvUB
fxXbUvGOBVRmkPkdJ92j01+TW1OjhoGcf5ikcFLJIhQrpcKqvGU2DbQFnsypDEbR
Pi7gpgrRzD9lqrVhRhvfKzXNS/AQJ2LOKye/ohdD+aIjEViAoDQe9jo4MtbTNUT9
tXqlF6QnljZTUdm3GHDDefc=
-----END PRIVATE KEY-----`

const TEST_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuuHIrY8YM2K7dsr/crjvf5N/JJaaSFnG2eU6N5AXnNyyZ7MsBQHAsO7yeQwOwqfdLAmqGuOUAtRjxQMeYbkFkWFO8BwwLTBfdRwyoPh4xsUQNZuKuu9+zy/l0sENo9qZxP8IdGd7DKM2K4r4S5JFpVYtq7UbnDw0KfwkNHUiuAKVAi3IEqBamiG3knDUqgTD8lAYgACGui8r4CywnKNq0kDzqcjJRNPnmbyT/OUfx20Ybgy1TbEKUARzs2bdeOCQym73P4g0+sgbY43Z2h5Z/V0NkQ1Qr11w7EkFAi8SOL2pb6M3QnsH1QvEGxyybw+5DRWnvoKJ7j3V5LdZt0vCqwIDAQAB'

const QUERY =
  'domain=example.com&dkim1=aaaa1111&dkim2=bbbb2222&dkim3=cccc3333&redirect_uri=https%3A%2F%2Fxstate.com%2Fsignup&state=dom_123'
const OPENSSL_SIG =
  'e4ZS13/S/l3FHSk8jqbxJXqCSSIqMajz7FySLu7pjH0SVKDQpOH6btQt12fzY3cP9oYkE0qYByYlWj+TqNvbY268HHjm9xoXKzzk9bT/MDGaeR6nxMADAvmOckvt2lWme+qxcPuge2MdQQ2yiArEBfTig4QUqYbngV8qu0e9R1FvPmejCAWsUSuyS79Rssz6wb0chUwQKtRDtkGDv6R7jrMyeTd7fAyvMVh3Iolhx386A1cpmu2+ICBf1a1KvLdZYWiNkOW6/jbuBihkaxw5gzjedCpaxtxIPrtdM2vIlkBSqcelxHpMw4inOGyM/HZUF9h/PPqdlB3gsWPRA1yVpA=='

const input = {
  urlSyncUX: 'https://dash.cloudflare.com/domainconnect',
  domain: 'example.com',
  variables: { dkim1: 'aaaa1111', dkim2: 'bbbb2222', dkim3: 'cccc3333' },
  redirectUri: 'https://xstate.com/signup',
  state: 'dom_123',
  keyHost: '_dck1',
  privateKey: TEST_PRIVATE_KEY,
}

describe('sign', () => {
  it('matches the signature OpenSSL makes with the same key', async () => {
    assert.equal(await sign(QUERY, TEST_PRIVATE_KEY), OPENSSL_SIG)
  })

  it('takes the key as PEM or as the base64 body on one line', async () => {
    const oneLine = TEST_PRIVATE_KEY.replace(/-----[^-]+-----|\s/g, '')
    assert.equal(await sign(QUERY, oneLine), OPENSSL_SIG)
  })
})

describe('buildApplyUrl', () => {
  it('signs the query string and appends key, then sig last', async () => {
    const url = await buildApplyUrl(input)
    assert.equal(
      url,
      'https://dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/xstate.io/services/mail/apply?' +
        `${QUERY}&key=_dck1&sig=${encodeURIComponent(OPENSSL_SIG)}`,
    )
    const params = [...new URL(url).searchParams.keys()]
    assert.deepEqual(params.slice(-2), ['key', 'sig'])
  })

  it('produces a signature the public key verifies over everything before key=', async () => {
    const url = await buildApplyUrl({ ...input, variables: { dkim1: 'a b+c/=', dkim2: 'x', dkim3: 'y' } })
    const query = url.slice(url.indexOf('?') + 1, url.indexOf('&key='))
    assert.match(query, /dkim1=a%20b%2Bc%2F%3D/, 'values are percent-encoded, spaces as %20')
    const sig = new URL(url).searchParams.get('sig')!
    const key = await crypto.subtle.importKey(
      'spki',
      Buffer.from(TEST_PUBLIC_KEY, 'base64'),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Buffer.from(sig, 'base64'), new TextEncoder().encode(query))
    assert.ok(ok)
  })

  it('leaves out redirect_uri and state when not given', async () => {
    const url = await buildApplyUrl({ ...input, redirectUri: undefined, state: undefined })
    const keys = [...new URL(url).searchParams.keys()]
    assert.deepEqual(keys, ['domain', 'dkim1', 'dkim2', 'dkim3', 'key', 'sig'])
  })
})

describe('publicKeyRecords', () => {
  it('splits the key into numbered RS256 records that join back into it', () => {
    const records = publicKeyRecords(TEST_PUBLIC_KEY)
    assert.equal(records.length, 2)
    assert.ok(records.every((r, i) => r.startsWith(`p=${i + 1},a=RS256,d=`) && r.length < 255))
    assert.equal(records.map((r) => r.replace(/^p=\d+,a=RS256,d=/, '')).join(''), TEST_PUBLIC_KEY)
  })
})

describe('discovery', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const mockFetch = (routes: Record<string, { status: number; body?: unknown }>) => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      const route = routes[String(url)] ?? { status: 404 }
      return new Response(route.body === undefined ? null : JSON.stringify(route.body), { status: route.status })
    }) as typeof fetch
    return calls
  }

  const cloudflare = {
    providerId: 'cloudflare.com',
    providerDisplayName: 'Cloudflare',
    urlSyncUX: 'https://dash.cloudflare.com/domainconnect',
    urlAPI: 'https://api.cloudflare.com/client/v4/dns/domainconnect',
  }

  it("reads the provider's settings from the _domainconnect host", async () => {
    const calls = mockFetch({
      'https://api.cloudflare.com/client/v4/dns/domainconnect/v2/example.com/settings': { status: 200, body: cloudflare },
    })
    assert.deepEqual(await fetchSettings('"api.cloudflare.com/client/v4/dns/domainconnect"', 'example.com'), cloudflare)
    assert.equal(calls.length, 1)
  })

  it('returns null for settings without an https urlSyncUX, or a bad host', async () => {
    mockFetch({ 'https://dc.example/v2/example.com/settings': { status: 200, body: { urlSyncUX: 'http://x' } } })
    assert.equal(await fetchSettings('dc.example', 'example.com'), null)
    assert.equal(await fetchSettings('http://dc.example', 'example.com'), null)
    assert.equal(await fetchSettings('', 'example.com'), null)
  })

  it('asks the provider whether our template is onboarded', async () => {
    const template = 'https://api.cloudflare.com/client/v4/dns/domainconnect/v2/domainTemplates/providers/xstate.io/services/mail'
    mockFetch({ [template]: { status: 200, body: {} } })
    assert.equal(await supportsTemplate(cloudflare), true)
    mockFetch({})
    assert.equal(await supportsTemplate(cloudflare), false)
    assert.equal(await supportsTemplate({ ...cloudflare, urlAPI: undefined }), false)
  })
})
