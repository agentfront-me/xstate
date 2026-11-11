// Everything behind sign-in. Waits for the account before showing a screen, so screens can use useAccount().

import { Redirect, Stack } from 'expo-router'
import { useAccountQuery } from '@/lib/account'
import { errorMessage } from '@/lib/api'
import { useLive } from '@/lib/live'
import { usePush } from '@/lib/push'
import { useSession } from '@/lib/session'
import { Failed, Loading, Screen } from '@/ui/kit'
import { c } from '@/ui/theme'

export default function AppLayout() {
  const { session } = useSession()
  const account = useAccountQuery()

  if (!session) return <Redirect href="/login" />
  if (account.isPending) {
    return (
      <Screen>
        <Loading />
      </Screen>
    )
  }
  if (account.isError) {
    return (
      <Screen>
        <Failed message={errorMessage(account.error)} onRetry={() => void account.refetch()} />
      </Screen>
    )
  }

  return (
    <>
      <Push />
      <Screens />
    </>
  )
}

/** Registers the phone for notifications and follows taps on them, and keeps the live-updates connection open
 * while the app is on screen (lib/live.ts). Only mounted once signed in. */
function Push() {
  usePush()
  useLive()
  return null
}

function Screens() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="compose" options={{ presentation: 'modal' }} />
    </Stack>
  )
}
