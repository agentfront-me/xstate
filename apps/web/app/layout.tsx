import { RootProvider } from 'fumadocs-ui/provider/next'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'
import { ThemeCookie } from './theme-cookie'

/** Runs in <head> before next-themes: the shared cookie decides, and a stale localStorage value is dropped. */
const themeCookieScript = `try {
  var m = document.cookie.match(/(?:^|; )theme=(light|dark)(?:;|$)/);
  if (m) localStorage.setItem('theme', m[1]); else localStorage.removeItem('theme');
} catch (e) {}`

/**
 * xstate's own analytics (docs/analytics-events.md), the same snippet as every page of the app. Loads only on
 * xstate.com and its subdomains, so local dev and previews send nothing.
 */
const analyticsScript = `window.xstate = window.xstate || function () { (xstate.q = xstate.q || []).push(arguments) }
if (/(^|\\.)xstate\\.com$/.test(location.hostname)) {
  xstate('init', 'pk_live_yu66CLbuyW9uTjnxwBdcVwRsSsZcojLd')
  var xs = document.createElement('script'); xs.async = true; xs.src = 'https://api.xstate.com/js/xstate.js'; document.head.appendChild(xs)
}`

export const metadata: Metadata = {
  metadataBase: new URL('https://xstate.com'),
  title: { default: 'xstate · Free business email on your own domain, built for AI apps', template: '%s · xstate' },
  description: 'Business email, calendar and files on your own domain, free for up to 5 people. Connect Claude, Codex or Cursor and choose what each one may do.',
  icons: { icon: '/favicon.svg', apple: '/brand/apple-touch-icon.png' },
  openGraph: { images: '/brand/og-image.png' },
}

// RootProvider runs the theme (the `dark` class on <html>, kept in localStorage under "theme") for the marketing
// pages and the docs alike, following the system unless a choice was made. The choice is shared with the app
// through a cookie (see theme-cookie.tsx). Docs search is off: agents search the docs with their own tool, and
// people use the sidebar.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeCookieScript }} />
        <script dangerouslySetInnerHTML={{ __html: analyticsScript }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }} theme={{ defaultTheme: 'system', enableSystem: true }}>
          <ThemeCookie />
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
