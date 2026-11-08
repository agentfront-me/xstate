'use client'

// Public file links used to be xstate.com/s/#<token>; they now live on go.xstate.com/s/. The token is in the
// #fragment, which browsers never send to the server, so this redirect has to happen in the page.
import { useEffect } from 'react'
import { APP_URL } from '@/lib/urls'

export default function MovedShareLink() {
  useEffect(() => {
    location.replace(`${APP_URL}/s/${location.search}${location.hash}`)
  }, [])
  return (
    <main style={{ padding: 24, fontSize: 14 }}>
      This link has moved. <a href={`${APP_URL}/s/`}>Open it on go.xstate.com</a>.
    </main>
  )
}
