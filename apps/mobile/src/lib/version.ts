// Which app this is: the version, the build (development, preview or production) and the over-the-air update it's
// running, if any. Shown under Log out in the side menu; tapping it copies `versionDetails()` for bug reports.

import Constants from 'expo-constants'
import * as Updates from 'expo-updates'
import { Platform } from 'react-native'
import { API_URL, APP_VARIANT } from './api'

const version = Constants.expoConfig?.version ?? '?'
/** The update's id, shortened; null when running the code the build came with. */
const update = !Updates.isEmbeddedLaunch && Updates.updateId ? Updates.updateId.slice(0, 8) : null

/** One short line, e.g. "Version 1.0.1 · preview · 01a1c91f". */
export const versionLabel = ['Version ' + version, APP_VARIANT, update].filter(Boolean).join(' · ')

/** Everything worth pasting into a bug report. */
export function versionDetails(): string {
  return [
    `xstate ${version} (${APP_VARIANT})`,
    `App: ${Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier : Constants.expoConfig?.android?.package}`,
    `Update: ${update ? `${Updates.updateId}${Updates.createdAt ? ` (${Updates.createdAt.toISOString()})` : ''}` : 'none, the code the build came with'}`,
    Updates.channel ? `Channel: ${Updates.channel} · runtime ${Updates.runtimeVersion ?? ''}` : null,
    `Device: ${Platform.OS === 'ios' ? 'iOS' : 'Android'} ${Platform.Version}${Constants.deviceName ? ` · ${Constants.deviceName}` : ''}`,
    `API: ${API_URL}`,
  ]
    .filter(Boolean)
    .join('\n')
}
