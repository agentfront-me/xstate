import { useSyncExternalStore } from 'react'

/** Whether the page is in dark mode right now (the `dark` class on <html>), re-rendering when it changes. */
export function useIsDark(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const observer = new MutationObserver(fn)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      return () => observer.disconnect()
    },
    () => document.documentElement.classList.contains('dark'),
  )
}
