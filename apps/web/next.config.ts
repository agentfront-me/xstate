import type { NextConfig } from 'next'

// Redirects of the old app URLs to go.xstate.com are in proxy.ts (it keeps the query string).
const config: NextConfig = {
  // A docs page as Markdown, for agents and scripts: /docs.md and /docs/<page>.md (see app/llms.mdx).
  async rewrites() {
    return [
      { source: '/docs.md', destination: '/llms.mdx/docs' },
      { source: '/docs/:path*.md', destination: '/llms.mdx/docs/:path*' },
    ]
  },
}

export default config
