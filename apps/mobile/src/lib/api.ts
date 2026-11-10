// Calls to the xstate API. The address comes from EXPO_PUBLIC_API_URL (eas.json per build profile, or .env.local
// for a local run) and falls back to production.

import Constants from 'expo-constants'
import { clearSession, currentSession } from './session'

export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'https://api.xstate.com/v1').replace(/\/$/, '')
export const APP_VARIANT = String(Constants.expoConfig?.extra?.variant ?? 'development')

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Calls the API and returns its JSON. `anonymous` leaves the session off (signing in). */
export async function api<T = unknown>(method: string, path: string, body?: unknown, options: { anonymous?: boolean } = {}): Promise<T> {
  const token = options.anonymous ? undefined : currentSession()?.token
  let res: Response
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('network', "Couldn't reach xstate. Check your connection and try again.", 0)
  }
  if (res.status === 204) return undefined as T
  if (res.ok) return (await res.json().catch(() => ({}))) as T
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
  if (res.status === 401 && token) {
    await clearSession()
    throw new ApiError('signed_out', 'Your session ended. Log in again.', 401)
  }
  throw new ApiError(data.error?.code ?? 'error', data.error?.message ?? 'Something went wrong. Try again.', res.status)
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong. Try again.')

export const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== false) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}
