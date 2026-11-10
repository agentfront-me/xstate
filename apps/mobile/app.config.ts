// Three variants of the app, picked by APP_VARIANT (set per build profile in eas.json):
//   development  a dev client for the simulator or your own phone
//   preview      an internal build for testers
//   production   the App Store / Play Store build
// Each has its own name and bundle id, so all three can be installed on one phone. Everything else is in app.json,
// which `eas init` and `eas update:configure` write to.

import type { ConfigContext, ExpoConfig } from 'expo/config'

const VARIANTS = {
  development: { name: 'xstate (Dev)', suffix: '.dev' },
  preview: { name: 'xstate (Preview)', suffix: '.preview' },
  production: { name: 'xstate', suffix: '' },
} as const

type Variant = keyof typeof VARIANTS

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant: Variant = process.env.APP_VARIANT && process.env.APP_VARIANT in VARIANTS ? (process.env.APP_VARIANT as Variant) : 'development'
  const { name, suffix } = VARIANTS[variant]
  return {
    ...config,
    name,
    slug: config.slug ?? 'xstate',
    ios: { ...config.ios, bundleIdentifier: `com.xstate.app${suffix}` },
    android: { ...config.android, package: `com.xstate.app${suffix}` },
    extra: { ...config.extra, variant },
  }
}
