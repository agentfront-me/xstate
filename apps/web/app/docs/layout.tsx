import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import type { ReactNode } from 'react'
import { source } from '@/lib/source'
import { SIGNUP_URL } from '@/lib/urls'

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      nav={{ title: 'xstate', url: '/' }}
      links={[{ text: 'Get started', url: SIGNUP_URL, external: true }]}
    >
      {children}
    </DocsLayout>
  )
}
