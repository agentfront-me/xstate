// Push notifications: new email, agent approvals and agent errors, sent by the API through Expo (apps/api/src/push).
// This registers the phone with the API, keeps the Settings switches and the picked domain in step with it (the API
// decides what to send), and opens the right screen when a notification is tapped.

import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { AndroidImportance } from 'expo-notifications'
import { type Href, router } from 'expo-router'
import { useEffect, useSyncExternalStore } from 'react'
import { Platform } from 'react-native'
import { queryClient } from './account'
import { api } from './api'
import { type Prefs, prefsLoaded, usePrefs } from './prefs'

/** on: registered. denied: the person said no (or turned it off in the phone's settings). unavailable: no token, as on a simulator. */
export type PushStatus = 'unknown' | 'on' | 'denied' | 'unavailable'

let status: PushStatus = 'unknown'
let token: string | null = null
const listeners = new Set<() => void>()

function setStatus(next: PushStatus) {
  status = next
  listeners.forEach((fn) => fn())
}

// With the app open, show the notification as a banner too.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
})

async function pushToken(): Promise<string | null> {
  if (token) return token
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Notifications', importance: AndroidImportance.DEFAULT })
  let permission = await Notifications.getPermissionsAsync()
  if (!permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync()
  if (!permission.granted) {
    setStatus('denied')
    return null
  }
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId
  token = (await Notifications.getExpoPushTokenAsync({ projectId })).data
  return token
}

/** Registers this phone with the API, or updates what it wants. Safe to call often. */
async function syncDevice(prefs: Prefs): Promise<void> {
  try {
    const t = await pushToken()
    if (!t) return
    await api('PUT', '/devices', { token: t, platform: Platform.OS, notify: prefs.notify, domainId: prefs.domainId })
    setStatus('on')
  } catch (err) {
    // No token on a simulator, or without the Apple / Firebase setup; the app works the same without notifications.
    if (!token) setStatus('unavailable')
    console.warn('push registration failed', err)
  }
}

/** Signing out: the API stops sending to this phone. Needs the session, so call it before clearing that. */
export async function removeDevice(): Promise<void> {
  if (!token) return
  await api('POST', '/devices/remove', { token }).catch(() => undefined)
}

export function usePushStatus(): PushStatus {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => status,
  )
}

/** A notification means something changed on the server: reload what it's about, whether or not it looks fresh. */
function reloadFor(kind: unknown) {
  if (kind === 'email') void queryClient.invalidateQueries({ queryKey: ['mail'] })
  else if (kind === 'approvals' || kind === 'agentErrors') void queryClient.invalidateQueries({ queryKey: ['agents'] })
}

let handled: string | null = null

/** Mounted once behind sign-in. */
export function usePush() {
  const prefs = usePrefs()
  useEffect(() => {
    void prefsLoaded.then(() => syncDevice(prefs))
  }, [prefs])

  // One arriving while the app is open.
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener((n) => reloadFor(n.request.content.data?.kind))
    return () => sub.remove()
  }, [])

  // A tap on a notification, including the one that opened the app. `path` is a screen in the app.
  const response = Notifications.useLastNotificationResponse()
  useEffect(() => {
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return
    const id = response.notification.request.identifier
    const path = response.notification.request.content.data?.path
    if (handled === id || typeof path !== 'string' || !path.startsWith('/')) return
    handled = id
    reloadFor(response.notification.request.content.data?.kind)
    router.push(path as Href)
  }, [response])
}
