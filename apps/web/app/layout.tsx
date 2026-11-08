import { RootProvider } from 'fumadocs-ui/provider/next'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  metadataBase: new URL('https://xstate.com'),
  title: { default: 'xstate · Your Digital Real Estate', template: '%s · xstate' },
  description: 'Your domain, emails, data, agents and sites in one place.',
  icons: { icon: '/favicon.svg', apple: '/brand/apple-touch-icon.png' },
  openGraph: { images: '/brand/og-image.png' },
}

// RootProvider runs the theme (the `dark` class on <html>, kept in localStorage under "theme", the same key the
// old site used) for the marketing pages and the docs alike. Docs search is off: agents search the docs with
// their own tool, and people use the sidebar.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ enabled: false }} theme={{ defaultTheme: 'light', enableSystem: false }}>
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
