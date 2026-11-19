import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import vm from 'node:vm'
import { normalizeSites, siteOf } from './site.ts'
import { snippet } from './snippet.ts'

describe('siteOf', () => {
  const sites = normalizeSites(['Acme.com', 'www.acme.com', 'eu.acme.com', 'other.io'])
  it('normalizes the organization’s domains', () => {
    assert.deepEqual(sites, ['acme.com', 'eu.acme.com', 'other.io'])
  })
  it('puts subdomains under the organization’s domain', () => {
    assert.equal(siteOf('acme.com', sites), 'acme.com')
    assert.equal(siteOf('go.acme.com', sites), 'acme.com')
    assert.equal(siteOf('a.b.acme.com', sites), 'acme.com')
    assert.equal(siteOf('app.other.io', sites), 'other.io')
  })
  it('prefers the longest matching domain', () => {
    assert.equal(siteOf('shop.eu.acme.com', sites), 'eu.acme.com')
  })
  it('leaves other hostnames as their own site', () => {
    assert.equal(siteOf('notacme.com', sites), 'notacme.com')
    assert.equal(siteOf('acme.com.evil.net', sites), 'acme.com.evil.net')
    assert.equal(siteOf('go.acme.com', []), 'go.acme.com')
  })
})

/** A cookie jar that behaves like a browser's: refuses cookies on a public suffix or a domain the page isn't on. */
function cookieJar(host: string, suffixes = ['com', 'co.uk', 'io']) {
  const jar = new Map<string, { value: string; domain: string }>()
  return {
    jar,
    for(pageHost: string) {
      return {
        get cookie() {
          return [...jar.entries()]
            .filter(([, c]) => pageHost === c.domain || pageHost.endsWith('.' + c.domain))
            .map(([k, c]) => `${k}=${c.value}`)
            .join('; ')
        },
        set cookie(raw: string) {
          const [pair, ...attrs] = raw.split(';')
          const [name, value] = [pair!.slice(0, pair!.indexOf('=')), pair!.slice(pair!.indexOf('=') + 1)]
          const opts = Object.fromEntries(attrs.map((a) => a.trim().split('=')).map(([k, v]) => [k!.toLowerCase(), v ?? '']))
          const domain = opts.domain ?? pageHost
          if (suffixes.includes(domain) || !(pageHost === domain || pageHost.endsWith('.' + domain))) return
          if (opts['max-age'] === '0') jar.delete(name)
          else jar.set(name, { value, domain })
        },
      }
    },
    host,
  }
}

/** Runs the snippet on a page at `url`, returning what it sent. */
function runSnippet(url: string, jar: ReturnType<typeof cookieJar>, options?: object, local = new Map<string, string>()) {
  const sent: { anonymousId: string; events: { type: string }[] }[] = []
  const u = new URL(url)
  const document = Object.assign(jar.for(u.hostname), {
    currentScript: { src: 'https://api.xstate.com/js/xstate.js' },
    referrer: '',
    visibilityState: 'visible',
    title: 'Test',
    documentElement: { scrollHeight: 0, scrollTop: 0 },
    body: { scrollHeight: 0 },
    addEventListener() {},
  })
  const window: Record<string, unknown> = {
    document,
    location: u,
    navigator: { language: 'en-US' },
    screen: { width: 1440, height: 900 },
    innerWidth: 1440,
    innerHeight: 900,
    scrollY: 0,
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    crypto: { getRandomValues: (a: Uint8Array) => globalThis.crypto.getRandomValues(a) },
    localStorage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
      removeItem: (k: string) => void local.delete(k),
    },
    fetch: (_: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body))
      return Promise.resolve()
    },
    setTimeout: (f: () => void) => (f(), 0),
    URL,
    Intl,
    Uint8Array,
  }
  window.window = window
  window.xstate = (...args: unknown[]) => ((window.xstate as { q?: unknown[] }).q ??= []).push(args)
  ;(window.xstate as (...a: unknown[]) => void)('init', 'pk_test', options)
  vm.runInNewContext(snippet('https://api.xstate.com'), window)
  return { sent, local, xstate: window.xstate as (...a: unknown[]) => void }
}

describe('snippet visitor id', () => {
  it('is shared between the site and its subdomains through a cookie on the top domain', () => {
    const jar = cookieJar('acme.com')
    const site = runSnippet('https://www.acme.com/pricing', jar)
    const app = runSnippet('https://go.acme.com/signup', jar)
    const id = site.sent[0]!.anonymousId
    assert.match(id, /^vis_[0-9a-f]{24}$/)
    assert.equal(app.sent[0]!.anonymousId, id)
    assert.equal(jar.jar.get('xstate_aid')!.domain, 'acme.com')
    assert.equal(jar.jar.has('xstate_t'), false, 'the probe cookie is removed')
  })

  it('continues the same visit across subdomains', () => {
    const jar = cookieJar('acme.com')
    const site = runSnippet('https://acme.com/', jar)
    const app = runSnippet('https://go.acme.com/signup', jar)
    const visit = (r: ReturnType<typeof runSnippet>) => (r.sent[0]!.events[0] as unknown as { context: { session: { id: string; start: boolean } } }).context.session
    assert.equal(visit(app).id, visit(site).id)
    assert.equal(visit(app).start, false)
  })

  it('finds the registrable domain under a two-part public suffix', () => {
    const jar = cookieJar('shop.acme.co.uk')
    runSnippet('https://shop.acme.co.uk/', jar)
    assert.equal(jar.jar.get('xstate_aid')!.domain, 'acme.co.uk')
  })

  it('moves an id from localStorage into the cookie', () => {
    const jar = cookieJar('acme.com')
    const local = new Map([['xstate_aid', 'vis_000000000000000000000001']])
    const r = runSnippet('https://acme.com/', jar, undefined, local)
    assert.equal(r.sent[0]!.anonymousId, 'vis_000000000000000000000001')
    assert.equal(decodeURIComponent(jar.jar.get('xstate_aid')!.value), 'vis_000000000000000000000001')
  })

  it('keeps to localStorage with cookie: false', () => {
    const jar = cookieJar('acme.com')
    const r = runSnippet('https://acme.com/', jar, { cookie: false })
    assert.equal(jar.jar.size, 0)
    assert.equal(r.local.get('xstate_aid'), r.sent[0]!.anonymousId)
  })

  it('reset clears the cookie and starts a new visitor', () => {
    const jar = cookieJar('acme.com')
    const r = runSnippet('https://acme.com/', jar)
    const before = r.sent[0]!.anonymousId
    r.xstate('reset')
    assert.equal(jar.jar.has('xstate_aid'), false)
    r.xstate('track', 'After reset')
    assert.notEqual(r.sent.at(-1)!.anonymousId, before)
  })

  it('uses a host-only cookie on localhost and IP addresses', () => {
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1:8787/']) {
      const jar = cookieJar('x')
      const r = runSnippet(url, jar)
      assert.equal(jar.jar.get('xstate_aid')!.domain, new URL(url).hostname)
      assert.equal(decodeURIComponent(jar.jar.get('xstate_aid')!.value), r.sent[0]!.anonymousId)
    }
  })
})
