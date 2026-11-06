// The dashboard (/app/) and the sign-in pages (/login/, /signup/) are React, built by Vite from src/. Everything
// in public/ (the marketing site, brand files) is copied as is. The output in dist/ is what Cloudflare serves
// (wrangler.jsonc) and what the desktop app bundles (apps/desktop, resources/web).
//
// `pnpm dev` serves the same URLs on http://localhost:8787 with hot reload, so the desktop app's --dev mode and
// the API's CORS settings (localhost:8787) keep working.

import fs from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const src = path.resolve(import.meta.dirname, 'src')
const pub = path.resolve(import.meta.dirname, 'public')

/**
 * Dev only: what Cloudflare's asset serving does in production (html_handling: auto-trailing-slash). /login
 * redirects to /login/, and pages that live in public/ (the marketing site) are served from their index.html.
 */
function cloudflareLikeRouting(): Plugin {
  return {
    name: 'xstate:cloudflare-like-routing',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const clean = url.pathname.replace(/\/+$/, '')
        const isPage = (dir: string) => fs.existsSync(path.join(dir, clean, 'index.html'))
        if (!url.pathname.endsWith('/') && !path.extname(url.pathname) && (isPage(src) || isPage(pub))) {
          res.writeHead(301, { Location: `${url.pathname}/${url.search}` })
          return res.end()
        }
        if (url.pathname.endsWith('/') && !isPage(src) && isPage(pub)) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          return res.end(fs.readFileSync(path.join(pub, clean, 'index.html')))
        }
        next()
      })
    },
  }
}

export default defineConfig({
  root: src,
  publicDir: pub,
  appType: 'mpa',
  plugins: [react(), cloudflareLikeRouting()],
  server: { port: 8787, strictPort: true },
  preview: { port: 8787, strictPort: true },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        app: path.join(src, 'app/index.html'),
        login: path.join(src, 'login/index.html'),
        signup: path.join(src, 'signup/index.html'),
      },
    },
  },
})
