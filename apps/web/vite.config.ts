// xstate.com: the marketing site and the docs (/docs), a Next.js App Router app built by vinext (Next.js on Vite)
// and served by a Cloudflare Worker (wrangler.jsonc). Every page is prerendered at build time and served from
// Workers Static Assets; the Worker only runs the redirects to go.xstate.com and the Markdown routes for agents.
//
// The docs are plain Markdown in content/docs, rendered by Fumadocs (fumadocs-mdx's Vite plugin + lib/source.ts).

import { cloudflare } from '@cloudflare/vite-plugin'
import { staticAssetsAdapter } from '@vinext/cloudflare/cache/static-assets-adapter'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import vinext from 'vinext'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    fumadocsMdx(),
    vinext({
      cache: { cdn: staticAssetsAdapter() },
      prerender: { routes: '*' },
    }),
    cloudflare({
      viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
    }),
  ],
})
