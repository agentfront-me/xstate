import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { channelOf, hostOf, sameSite } from './channel.ts'
import { isBot, parseUserAgent } from './device.ts'
import { counterparts } from './email.ts'
import { addEngagement, applyEmail, applyEvent, identified, mergeMetrics } from './metrics.ts'
import type { CollectItem } from './types.ts'

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  samsungPhone: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

describe('parseUserAgent', () => {
  it('names the browser, system and device', () => {
    assert.deepEqual(parseUserAgent(UA.chromeMac), { browser: 'Chrome', browserVersion: '131', os: 'macOS', osVersion: null, deviceType: 'desktop' })
    assert.deepEqual(parseUserAgent(UA.safariIphone), { browser: 'Safari', browserVersion: '18', os: 'iOS', osVersion: '18', deviceType: 'mobile' })
    assert.deepEqual(parseUserAgent(UA.chromeIphone), { browser: 'Chrome', browserVersion: '130', os: 'iOS', osVersion: '17', deviceType: 'mobile' })
    assert.deepEqual(parseUserAgent(UA.ipad), { browser: 'Safari', browserVersion: '17', os: 'iOS', osVersion: '17', deviceType: 'tablet' })
    assert.deepEqual(parseUserAgent(UA.edgeWin), { browser: 'Edge', browserVersion: '131', os: 'Windows', osVersion: '10', deviceType: 'desktop' })
    assert.deepEqual(parseUserAgent(UA.firefoxLinux), { browser: 'Firefox', browserVersion: '133', os: 'Linux', osVersion: null, deviceType: 'desktop' })
    assert.deepEqual(parseUserAgent(UA.samsungPhone), { browser: 'Samsung Internet', browserVersion: '26', os: 'Android', osVersion: '14', deviceType: 'mobile' })
    assert.equal(parseUserAgent(UA.androidTablet).deviceType, 'tablet')
  })
  it('returns nulls for nothing', () => {
    assert.deepEqual(parseUserAgent(''), { browser: null, browserVersion: null, os: null, osVersion: null, deviceType: null })
  })
})

describe('isBot', () => {
  it('flags crawlers, previews, scripts and empty agents', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
      'curl/8.4.0',
      'python-requests/2.31.0',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      '',
      null,
    ]) assert.equal(isBot(ua), true, String(ua))
  })
  it('lets real browsers through', () => {
    for (const ua of Object.values(UA)) assert.equal(isBot(ua), false, ua)
  })
})

describe('channelOf', () => {
  it('uses UTM medium first', () => {
    assert.equal(channelOf({ campaign: { source: 'google', medium: 'cpc' } }), 'Paid search')
    assert.equal(channelOf({ campaign: { source: 'facebook', medium: 'cpc' } }), 'Paid social')
    assert.equal(channelOf({ campaign: { source: 'linkedin', medium: 'paid_social' } }), 'Paid social')
    assert.equal(channelOf({ campaign: { source: 'weekly', medium: 'email' } }), 'Email')
    assert.equal(channelOf({ campaign: { source: 'partnerco', medium: 'affiliate' } }), 'Affiliate')
    assert.equal(channelOf({ campaign: { source: 'twitter', medium: 'social' } }), 'Social')
  })
  it('then ad click ids', () => {
    assert.equal(channelOf({ clickId: 'gclid', referringDomain: 'google.com' }), 'Paid search')
    assert.equal(channelOf({ clickId: 'ttclid' }), 'Paid social')
    assert.equal(channelOf({ clickId: 'fbclid', referringDomain: 'l.facebook.com' }), 'Social')
  })
  it('then the source or the referring site', () => {
    assert.equal(channelOf({ campaign: { source: 'newsletter' } }), 'Email')
    assert.equal(channelOf({ campaign: { source: 'chatgpt.com' } }), 'AI assistant')
    assert.equal(channelOf({ referringDomain: 'google.co.uk' }), 'Organic search')
    assert.equal(channelOf({ referringDomain: 'duckduckgo.com' }), 'Organic search')
    assert.equal(channelOf({ referringDomain: 'gemini.google.com' }), 'AI assistant')
    assert.equal(channelOf({ referringDomain: 'chatgpt.com' }), 'AI assistant')
    assert.equal(channelOf({ referringDomain: 'mail.google.com' }), 'Email')
    assert.equal(channelOf({ referringDomain: 'm.facebook.com' }), 'Social')
    assert.equal(channelOf({ referringDomain: 't.co' }), 'Social')
    assert.equal(channelOf({ referringDomain: 'someblog.dev' }), 'Referral')
    assert.equal(channelOf({ campaign: { source: 'flyer' } }), 'Other')
    assert.equal(channelOf({}), 'Direct')
  })
})

describe('hosts', () => {
  it('normalizes and compares sites', () => {
    assert.equal(hostOf('https://www.Acme.com./pricing?x=1'), 'acme.com')
    assert.equal(hostOf('mailto:a@b.c'), null)
    assert.equal(hostOf('not a url'), null)
    assert.equal(sameSite('shop.acme.com', 'acme.com'), true)
    assert.equal(sameSite('acme.com', 'notacme.com'), false)
  })
})

describe('metrics', () => {
  const item = (over: Partial<CollectItem>): CollectItem => ({
    type: 'page', domain: 'acme.com', anonymousId: 'vis_1', userId: null, email: null, traits: {}, event: null,
    properties: {}, url: 'https://acme.com/', context: {}, at: '2026-11-18T10:00:00.000Z', ...over,
  })
  it('keeps the first touch and moves the last touch', () => {
    let m = applyEvent({}, item({ context: { sessionStart: true, channel: 'Paid search', campaign: { source: 'google', medium: 'cpc', name: 'brand' }, clickId: 'gclid', path: '/pricing', country: 'DE', city: 'Berlin', browser: 'Chrome' } }), { newSession: true })
    m = applyEvent(m, item({ context: { sessionStart: true, channel: 'Referral', referringDomain: 'blog.dev', path: '/', country: 'FR' }, at: '2026-11-19T09:00:00.000Z' }), { newSession: true })
    assert.equal(m.initial_channel, 'Paid search')
    assert.equal(m.initial_utm_campaign, 'brand')
    assert.equal(m.initial_click_id, 'gclid')
    assert.equal(m.initial_landing_page, '/pricing')
    assert.equal(m.last_channel, 'Referral')
    assert.equal(m.last_utm_source, undefined)
    assert.equal(m.last_referring_domain, 'blog.dev')
    assert.equal(m.first_country, 'DE')
    assert.equal(m.country, 'FR')
    assert.equal(m.city, undefined)
    assert.equal(m.sessions, 2)
    assert.equal(m.pageviews, 2)
    assert.equal(m.active_days, 2)
  })
  it('adds up revenue and counts orders', () => {
    let m = applyEvent({}, item({ type: 'track', event: 'Order Completed', properties: { revenue: 48.5, currency: 'usd' } }), { newSession: false })
    m = applyEvent(m, item({ type: 'track', event: 'Order Completed', properties: { revenue: '20' } }), { newSession: false })
    m = applyEvent(m, item({ type: 'track', event: 'Viewed', properties: { revenue: 'n/a' } }), { newSession: false })
    assert.equal(m.revenue_total, 68.5)
    assert.equal(m.orders, 2)
    assert.equal(m.currency, 'USD')
    assert.equal(m.last_event, 'Viewed')
    assert.equal(m.active_days, 1)
  })
  it('merges a lead into a user', () => {
    const lead = { sessions: 2, pageviews: 5, initial_channel: 'Social', first_country: 'US' }
    const user = { sessions: 1, pageviews: 1, initial_channel: 'Direct', first_country: 'GB', last_channel: 'Email' }
    const m = mergeMetrics(lead, user, true)
    assert.equal(m.sessions, 3)
    assert.equal(m.pageviews, 6)
    assert.equal(m.initial_channel, 'Social')
    assert.equal(m.first_country, 'US')
    assert.equal(m.last_channel, 'Email')
    assert.equal(identified({}, '2026-11-18T00:00:00Z', '2026-11-10T00:00:00Z').days_to_identify, 8)
    assert.equal(addEngagement({}, 61_400).engaged_seconds, 61)
  })
})

describe('email activity', () => {
  it('finds the other side of a message, without our own addresses', () => {
    const msg = { from: [{ email: 'Ana@Example.test' }], to: [{ email: 'sales@acme.com' }, { email: 'bo@example.test' }], cc: [{ email: 'help@acme.com' }] }
    assert.deepEqual(counterparts('in', msg, ['sales@acme.com', 'help@acme.com']), ['ana@example.test'])
    assert.deepEqual(counterparts('out', { from: [{ email: 'sales@acme.com' }], to: msg.to, cc: msg.cc }, ['sales@acme.com', 'help@acme.com']), ['bo@example.test'])
  })
  it('counts mail and flags bounces', () => {
    let m = applyEmail({}, 'received', '2026-11-18T10:00:00Z')
    m = applyEmail(m, 'sent', '2026-11-18T11:00:00Z')
    m = applyEmail(m, 'replied', '2026-11-18T09:00:00Z')
    m = applyEmail(m, 'bounced', '2026-11-18T12:00:00Z')
    assert.deepEqual(m, { emails_received: 1, emails_sent: 1, emails_replied: 1, last_email_at: '2026-11-18T11:00:00Z', email_bounced: true })
  })
})
