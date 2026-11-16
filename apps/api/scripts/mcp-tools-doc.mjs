// Runs mcp-tools-doc.ts under Node: bundles it with esbuild (already here through wrangler), with the Workers-only
// modules the operations import replaced by empty stand-ins. Only names, descriptions and scopes are read.
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xstate-mcp-doc-')), 'run.mjs')
await build({
  entryPoints: [path.join(import.meta.dirname, 'mcp-tools-doc.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'error',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { 'import.meta.dirname': JSON.stringify(import.meta.dirname) },
  plugins: [
    {
      name: 'workers-stubs',
      setup(b) {
        b.onResolve({ filter: /^cloudflare:/ }, (args) => ({ path: args.path, namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export class DurableObject {}; export class WorkflowEntrypoint {}; export class WorkerEntrypoint {}; export class RpcTarget {}; export class EmailMessage {}; export const exports = {}; export const env = {}; export const waitUntil = () => {}; export const connect = () => {}; export class NonRetryableError extends Error {}',
          loader: 'js',
        }))
      },
    },
  ],
})
process.argv = [process.argv[0], out, ...process.argv.slice(2)]
await import(pathToFileURL(out).href)
