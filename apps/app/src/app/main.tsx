// The dashboard at /app/. Loads the account first: no session means the sign-in page, and a failed load shows a
// retry screen. Then the router takes over (see router.tsx).

import '../styles/dashboard.css'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Icon } from '../components/Icon'
import { Toaster } from '../components/Toast'
import { queryClient, useAccountQuery } from '../lib/account'
import { ApiError, applyTheme, signOut, themeChoice } from '../lib/core'
import { router } from './router'

applyTheme(themeChoice())

function App() {
  const account = useAccountQuery()

  useEffect(() => {
    if (account.isSuccess && !account.data) location.assign('/login')
  }, [account.isSuccess, account.data])

  if (account.isError) {
    const err = account.error
    if (err instanceof ApiError && err.code === 'signed_out') return null
    return (
      <div className="empty">
        <Icon name="circle-alert" size={24} />
        <strong>Couldn't load your account</strong>
        <span>{err.message}</span>
        <span style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn" onClick={() => void account.refetch()}>
            Try again
          </button>
          <button className="btn btn-quiet" onClick={signOut}>
            Sign out
          </button>
        </span>
      </div>
    )
  }
  if (!account.data) {
    return (
      <div className="loading">
        <span className="spinner" />
      </div>
    )
  }
  return <RouterProvider router={router} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
)
