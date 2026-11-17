// Two jobs, both before any page is served:
//
// 1. The product moved from xstate.com to go.xstate.com. Old links (bookmarks, emails, the Domain Connect return
//    address) keep working through redirects, query string included. /s/#token links are redirected by
//    app/s/page.tsx instead, because the token is in the #fragment, which never reaches the server.
// 2. The blog and changelog answer to the Accept header: a request that asks for JSON or Markdown and not HTML gets
//    the same content as /blog/<post>.json or .md, and /blog with JSON gets the feed. Browsers always ask for text/html, so they
//    are never affected.
import { type NextRequest, NextResponse } from 'next/server'
import { APP_URL } from './lib/urls'

/** "json", "markdown", or null for HTML (and anything else). */
function wants(accept: string): 'json' | 'markdown' | null {
  if (!accept || accept.includes('text/html')) return null
  if (/application\/(feed\+)?json/.test(accept)) return 'json'
  if (accept.includes('text/markdown')) return 'markdown'
  return null
}

function negotiated(request: NextRequest, pathname: string) {
  // Files (/blog/feed.json, /blog/<post>.md) already say what they are.
  if (pathname.includes('.')) return NextResponse.next()
  const format = wants(request.headers.get('accept') ?? '')
  const path = pathname.replace(/\/$/, '')
  let target: string | null = null
  // Straight to the route handlers next.config.ts rewrites /blog/<post>.json and .md to.
  if (format === 'json') target = path === '/blog' ? '/blog/feed.json' : `/llms.json${path}`
  else if (format === 'markdown' && path !== '/blog') target = `/llms.mdx${path}`
  const response = target ? NextResponse.rewrite(new URL(target, request.url)) : NextResponse.next()
  response.headers.set('Vary', 'Accept')
  return response
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  if (/^\/(blog|changelog)(\/|$)/.test(pathname)) return negotiated(request, pathname)
  // The app's pages are folders (/signup/, /app/), so keep the trailing slash it expects.
  const path = /^\/(app|login|signup)$/.test(pathname) ? `${pathname}/` : pathname
  return NextResponse.redirect(`${APP_URL}${path}${search}`, 308)
}

export const config = {
  matcher: [
    '/app',
    '/app/:path*',
    '/login',
    '/login/:path*',
    '/signup',
    '/signup/:path*',
    '/blog',
    '/blog/:slug',
    '/changelog',
  ],
}
