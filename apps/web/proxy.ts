// The product moved from xstate.com to go.xstate.com. Old links (bookmarks, emails, the Domain Connect return
// address) keep working through these redirects, query string included. /s/#token links are redirected by
// app/s/page.tsx instead, because the token is in the #fragment, which never reaches the server.
import { type NextRequest, NextResponse } from 'next/server'
import { APP_URL } from './lib/urls'

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  // The app's pages are folders (/signup/, /app/), so keep the trailing slash it expects.
  const path = /^\/(app|login|signup)$/.test(pathname) ? `${pathname}/` : pathname
  return NextResponse.redirect(`${APP_URL}${path}${search}`, 308)
}

export const config = {
  matcher: ['/app', '/app/:path*', '/login', '/login/:path*', '/signup', '/signup/:path*'],
}
