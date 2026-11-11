// Live updates while the app is on screen: a WebSocket to the API (apps/api/src/live) that says what changed, as
// ids only ("mailbox X", "agent Y"). On each, the matching lists reload quietly through the normal API. Open while
// the app is active, closed when it goes to the background; it reconnects on its own after a drop, and a reconnect
// reloads mail and agents once to catch up on anything said while it was away.

import { useEffect } from 'react'
import { AppState } from 'react-native'
import { queryClient, useAccount } from './account'
import { API_URL } from './api'
import { currentSession } from './session'

type LiveEvent = { type: 'mail'; mailboxId: string } | { type: 'agents'; agentId: string }

// React Native's WebSocket takes headers as a third argument; the DOM types it's typed with don't know that.
type NativeWebSocket = new (url: string, protocols: string | string[] | null, options: { headers: Record<string, string> }) => WebSocket

const PING_MS = 30_000
const MAX_WAIT_MS = 30_000

function reload(event: LiveEvent) {
  if (event.type === 'mail') void queryClient.invalidateQueries({ queryKey: ['mail'] })
  else if (event.type === 'agents') void queryClient.invalidateQueries({ queryKey: ['agents'] })
}

/** Mounted once behind sign-in. */
export function useLive() {
  const { org } = useAccount()

  useEffect(() => {
    const url = `${API_URL.replace(/^http/, 'ws')}/live/orgs/${org.id}`
    let ws: WebSocket | null = null
    let ping: ReturnType<typeof setInterval> | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let opened = false
    let active = false

    function connect() {
      const token = currentSession()?.token
      if (!active || ws || !token) return
      // Signed in like every other call.
      const socket = new (WebSocket as unknown as NativeWebSocket)(url, null, { headers: { Authorization: `Bearer ${token}` } })
      ws = socket
      socket.onopen = () => {
        failures = 0
        // The first connection comes with lists that just loaded; later ones may have missed something.
        if (opened) {
          void queryClient.invalidateQueries({ queryKey: ['mail'] })
          void queryClient.invalidateQueries({ queryKey: ['agents'] })
        }
        opened = true
        ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('ping'), PING_MS)
      }
      socket.onmessage = (e) => {
        if (typeof e.data !== 'string' || e.data === 'pong') return
        try {
          reload(JSON.parse(e.data) as LiveEvent)
        } catch {
          // Not something this version knows.
        }
      }
      socket.onclose = () => {
        clearInterval(ping)
        if (ws === socket) ws = null
        if (!active) return
        // 1s, 2s, 4s … up to 30s between tries.
        retry = setTimeout(connect, Math.min(MAX_WAIT_MS, 1000 * 2 ** failures++))
      }
    }

    function start() {
      active = true
      connect()
    }
    function stop() {
      active = false
      clearTimeout(retry)
      clearInterval(ping)
      ws?.close()
      ws = null
    }

    if (AppState.currentState === 'active') start()
    const sub = AppState.addEventListener('change', (state) => (state === 'active' ? start() : stop()))
    return () => {
      sub.remove()
      stop()
    }
  }, [org.id])
}
