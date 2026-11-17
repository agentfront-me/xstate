import type { NextConfig } from 'next'

// Redirects of the old app URLs to go.xstate.com are in proxy.ts (it keeps the query string).
const config: NextConfig = {
  // A page as Markdown or JSON, for agents and scripts: /docs.md, /docs/<page>.md, /blog/<post>.md and .json,
  // /changelog.md and .json (see app/llms.mdx and app/llms.json). proxy.ts sends Accept headers to the same places.
  async rewrites() {
    return [
      { source: '/docs.md', destination: '/llms.mdx/docs' },
      { source: '/docs/:path*.md', destination: '/llms.mdx/docs/:path*' },
      { source: '/blog/:slug.md', destination: '/llms.mdx/blog/:slug' },
      { source: '/blog/:slug.json', destination: '/llms.json/blog/:slug' },
      { source: '/changelog.md', destination: '/llms.mdx/changelog' },
      { source: '/changelog.json', destination: '/llms.json/changelog' },
    ]
  },
}

export default config
