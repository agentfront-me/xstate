// What a User-Agent says about the visitor's browser, system and device, and whether it's a bot. Small and
// dependency-free on purpose: it runs on every collected event, and only needs the names a dashboard groups by.
// Versions are major versions only ("Chrome 131", "iOS 18"), which is what people compare.

export type Device = {
  browser: string | null
  browserVersion: string | null
  os: string | null
  osVersion: string | null
  deviceType: 'desktop' | 'mobile' | 'tablet' | null
}

// Crawlers, link previews, monitors, headless browsers and HTTP libraries. Their "visits" are dropped, not stored.
const BOT =
  /bot\b|bot[/;)]|crawl|spider|slurp|scrape|headless|lighthouse|pagespeed|pingdom|uptime|monitor|preview|prerender|facebookexternalhit|embedly|quora link|whatsapp|telegram|discord|vkshare|curl\/|wget|python-|httpx|aiohttp|axios|node-fetch|undici|go-http|okhttp|java\/|libwww|phantomjs|selenium|puppeteer|playwright|cypress|gptbot|chatgpt-user|claude-web|claudebot|perplexitybot|bytespider|amazonbot|applebot|yandex(bot|images)|baiduspider|duckduckbot|bingpreview/i

/** True for an empty User-Agent or one that names a bot or a script. */
export function isBot(userAgent: string | null | undefined): boolean {
  const ua = userAgent?.trim()
  return !ua || BOT.test(ua)
}

const major = (v: string | undefined) => (v ? (v.split(/[._]/)[0] ?? null) : null)

export function parseUserAgent(userAgent: string | null | undefined): Device {
  const ua = userAgent ?? ''
  if (!ua) return { browser: null, browserVersion: null, os: null, osVersion: null, deviceType: null }

  // Order matters: Edge, Opera and Samsung say "Chrome" too, and every iOS browser says "Safari".
  let browser: string | null = null
  let browserVersion: string | null = null
  const browsers: [string, RegExp][] = [
    ['Edge', /\bEdg(?:e|A|iOS)?\/([\d.]+)/],
    ['Opera', /\b(?:OPR|OPiOS)\/([\d.]+)/],
    ['Samsung Internet', /\bSamsungBrowser\/([\d.]+)/],
    ['Yandex', /\bYaBrowser\/([\d.]+)/],
    ['Vivaldi', /\bVivaldi\/([\d.]+)/],
    ['Facebook', /\b(?:FBAV|FBAN)\/([\d.]+)/],
    ['Instagram', /\bInstagram ([\d.]+)/],
    ['Firefox', /\b(?:Firefox|FxiOS)\/([\d.]+)/],
    ['Chrome', /\b(?:Chrome|CriOS)\/([\d.]+)/],
    ['Safari', /\bVersion\/([\d.]+).*Safari\//],
  ]
  for (const [name, re] of browsers) {
    const m = ua.match(re)
    if (m) {
      browser = name
      browserVersion = major(m[1])
      break
    }
  }
  if (!browser && /Safari\//.test(ua) && /AppleWebKit/.test(ua)) browser = 'Safari'

  let os: string | null = null
  let osVersion: string | null = null
  let m: RegExpMatchArray | null
  if ((m = ua.match(/\b(?:iPhone|iPad|iPod)\b.*?\bOS (\d+)[_\d]*/))) {
    os = 'iOS'
    osVersion = m[1] ?? null
  } else if ((m = ua.match(/\bAndroid (\d+)?/))) {
    os = 'Android'
    osVersion = m[1] ?? null
  } else if (/\bCrOS\b/.test(ua)) {
    os = 'ChromeOS'
  } else if ((m = ua.match(/\bWindows NT (\d+\.\d+)/))) {
    os = 'Windows'
    // NT 10.0 is both 10 and 11; browsers stopped telling them apart.
    osVersion = { '10.0': '10', '6.3': '8.1', '6.2': '8', '6.1': '7' }[m[1]!] ?? null
  } else if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) {
    os = 'macOS'
  } else if (/\bLinux\b/.test(ua)) {
    os = 'Linux'
  }

  const tablet = /\biPad\b|\bTablet\b|\bKindle\b|\bSilk\//.test(ua) || (os === 'Android' && !/\bMobile\b/.test(ua))
  const mobile = !tablet && (/\bMobi|\biPhone\b|\biPod\b/.test(ua) || os === 'Android')
  return { browser, browserVersion, os, osVersion, deviceType: tablet ? 'tablet' : mobile ? 'mobile' : 'desktop' }
}
