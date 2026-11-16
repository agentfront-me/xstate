'use client'

// Shares the Light/Dark choice with the app at go.xstate.com. next-themes keeps the choice in localStorage, which
// belongs to one origin, so it is mirrored into a `theme` cookie on .xstate.com that both sites read. No cookie
// means "follow the system". The app side is in apps/app/src/lib/core.ts.

import { useTheme } from 'next-themes'
import { useEffect } from 'react'

/** Writes the cookie whenever the theme changes. The script in layout.tsx reads it back on each page load. */
export function ThemeCookie() {
  const { theme } = useTheme()
  useEffect(() => {
    if (!theme) return
    const domain = /(^|\.)xstate\.com$/.test(location.hostname) ? '; domain=xstate.com' : ''
    const secure = location.protocol === 'https:' ? '; secure' : ''
    const value = theme === 'light' || theme === 'dark' ? `theme=${theme}; max-age=31536000` : 'theme=; max-age=0'
    document.cookie = `${value}; path=/; samesite=lax${domain}${secure}`
  }, [theme])
  return null
}
