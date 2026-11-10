import { QueryClientProvider } from '@tanstack/react-query'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { queryClient } from '@/lib/account'
import { loadSession, useSession } from '@/lib/session'
import { ToastProvider } from '@/ui/kit'
import { c } from '@/ui/theme'

export default function RootLayout() {
  const { ready } = useSession()

  useEffect(() => {
    void loadSession()
  }, [])

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: c.bg }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <StatusBar style="light" />
            {ready ? <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }} /> : <View style={{ flex: 1, backgroundColor: c.bg }} />}
          </ToastProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
