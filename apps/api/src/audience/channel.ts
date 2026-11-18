// Where a visit came from, as one of a few channels a dashboard groups by. Decided once per session, from the
// landing page's UTM tags and ad click id, else the referring site. Close to Google Analytics' default channel
// grouping, plus "AI assistant" for chat apps that link out.

export const CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'ttclid', 'li_fat_id', 'twclid'] as const
export type ClickId = (typeof CLICK_IDS)[number]

export type Channel =
  | 'Direct'
  | 'Organic search'
  | 'Paid search'
  | 'Social'
  | 'Paid social'
  | 'Email'
  | 'Referral'
  | 'Affiliate'
  | 'Display'
  | 'AI assistant'
  | 'Other'

export type Campaign = { source?: string; medium?: string; name?: string; term?: string; content?: string }

const SEARCH = [/(^|\.)google\.[a-z.]+$/, /(^|\.)bing\.com$/, /(^|\.)duckduckgo\.com$/, /(^|\.)yahoo\.[a-z.]+$/, /(^|\.)yandex\.[a-z.]+$/,
  /(^|\.)baidu\.com$/, /(^|\.)ecosia\.org$/, /^search\.brave\.com$/, /(^|\.)startpage\.com$/, /(^|\.)naver\.com$/, /(^|\.)qwant\.com$/, /(^|\.)kagi\.com$/]
const SOCIAL = ['facebook.com', 'fb.com', 'fb.me', 'instagram.com', 't.co', 'twitter.com', 'x.com', 'linkedin.com', 'lnkd.in', 'reddit.com',
  'youtube.com', 'youtu.be', 'pinterest.com', 'tiktok.com', 'threads.net', 'bsky.app', 'mastodon.social', 'news.ycombinator.com',
  'snapchat.com', 'tumblr.com', 'quora.com', 'discord.com', 'telegram.org', 'whatsapp.com', 'medium.com', 'vk.com', 'weibo.com']
const AI = ['chatgpt.com', 'chat.openai.com', 'openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'bard.google.com',
  'copilot.microsoft.com', 'you.com', 'phind.com', 'poe.com', 'chat.deepseek.com', 'grok.com', 'meta.ai', 'chat.mistral.ai']
const WEBMAIL = ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com', 'mail.proton.me',
  'app.fastmail.com', 'mail.aol.com', 'go.xstate.com']
const SOCIAL_SOURCES = /^(facebook|fb|instagram|ig|twitter|x|linkedin|reddit|youtube|pinterest|tiktok|threads|bluesky|snapchat|meta)$/
const SEARCH_SOURCES = /^(google|bing|yahoo|duckduckgo|baidu|yandex|ecosia|brave|adwords|google ?ads|microsoft ?ads)$/

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)
const isSearch = (host: string) => SEARCH.some((re) => re.test(host))
const isSocial = (host: string) => SOCIAL.some((d) => under(host, d))
const isAi = (host: string) => AI.some((d) => under(host, d))
const isWebmail = (host: string) => WEBMAIL.some((d) => under(host, d))

/** A hostname without www. and the trailing dot, or null if it isn't an http(s) URL. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') : null
  } catch {
    return null
  }
}

/** The same site: one host is the other, or under it (shop.acme.com and acme.com). */
export function sameSite(a: string, b: string): boolean {
  return under(a, b) || under(b, a)
}

export function channelOf(input: { campaign?: Campaign | null; clickId?: ClickId | null; referringDomain?: string | null }): Channel {
  const medium = input.campaign?.medium?.trim().toLowerCase() ?? ''
  const source = input.campaign?.source?.trim().toLowerCase() ?? ''
  const ref = input.referringDomain ?? ''
  const socialSource = SOCIAL_SOURCES.test(source) || (!!ref && isSocial(ref))

  if (medium) {
    if (/^(paid[_ -]?social|social[_ -]?paid|psocial)$/.test(medium)) return 'Paid social'
    if (/^(cpc|ppc|paid|paid[_ -]?search|sem|cpv|cpa|retargeting)$/.test(medium)) return socialSource ? 'Paid social' : 'Paid search'
    if (/^(display|banner|cpm|expandable|interstitial)$/.test(medium)) return 'Display'
    if (/e[-_ ]?mail|newsletter/.test(medium)) return 'Email'
    if (/^(affiliate|affiliates|partner|partners)$/.test(medium)) return 'Affiliate'
    if (/^(social|social[_ -]?network|social[_ -]?media|sm|organic[_ -]?social)$/.test(medium)) return 'Social'
    if (medium === 'organic') return 'Organic search'
    if (medium === 'referral') return 'Referral'
  }
  switch (input.clickId) {
    case 'gclid':
    case 'gbraid':
    case 'wbraid':
    case 'msclkid':
      return 'Paid search'
    case 'ttclid':
    case 'li_fat_id':
    case 'twclid':
      return 'Paid social'
    case 'fbclid':
      // Facebook adds it to every outbound link, paid or not.
      return 'Social'
  }
  if (source) {
    if (SOCIAL_SOURCES.test(source)) return 'Social'
    if (SEARCH_SOURCES.test(source)) return 'Organic search'
    if (/^(chatgpt|openai|perplexity|claude|gemini|copilot)/.test(source)) return 'AI assistant'
    if (/e[-_ ]?mail|newsletter/.test(source)) return 'Email'
  }
  if (ref) {
    // AI and webmail first: gemini.google.com and mail.google.com would otherwise count as Google search.
    if (isAi(ref)) return 'AI assistant'
    if (isWebmail(ref)) return 'Email'
    if (isSearch(ref)) return 'Organic search'
    if (isSocial(ref)) return 'Social'
    return 'Referral'
  }
  return source || medium ? 'Other' : 'Direct'
}
