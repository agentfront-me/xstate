// A small confirmation line at the bottom of the window. Call toast() from anywhere; <Toaster /> shows it.

import { useSyncExternalStore } from 'react'

let current = { message: '', on: false, id: 0 }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined

function set(next: typeof current) {
  current = next
  listeners.forEach((fn) => fn())
}

export function toast(message: string): void {
  set({ message, on: true, id: current.id + 1 })
  clearTimeout(timer)
  timer = setTimeout(() => set({ ...current, on: false }), 2600)
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function Toaster() {
  const { message, on } = useSyncExternalStore(subscribe, () => current)
  return (
    <div className={`toast${on ? ' is-on' : ''}`} role="status">
      {message}
    </div>
  )
}
