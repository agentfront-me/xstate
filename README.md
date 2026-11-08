# xstate

Free business email with agents. A pnpm + Turborepo monorepo of Cloudflare Workers, laid out like upfold.

## Layout

| Path | Package | What it is |
| --- | --- | --- |
| `apps/api` | `@xstate/api` | Hono Worker: the HTTP API. |
| `apps/web` | `@xstate/web` | xstate.com: the marketing site and the docs at `/docs` (Next.js on Cloudflare Workers via vinext; docs are the Markdown files in `content/docs`, rendered by Fumadocs). Redirects the old `/app`, `/login`, `/signup` and `/s` URLs to go.xstate.com. |
| `apps/app` | `@xstate/app` | go.xstate.com, served as Worker assets: the React dashboard at `/app/`, sign-up and sign-in pages and public file links (`src/`, built with Vite). |
| `apps/desktop` | `@xstate/desktop` | Electron app that wraps the dashboard (bundles `apps/app/dist`, served from `app://xstate`). |
| `packages/` | | Shared libraries (`@xstate/<name>`), added when needed. |
| `tooling/tsconfig` | `@xstate/tsconfig` | Shared TypeScript base config. |
| `docs/` | | Product docs and notes. |

## Develop

```bash
pnpm install
pnpm --filter @xstate/api dev    # http://localhost:8788/health
pnpm --filter @xstate/app dev    # http://localhost:8787 (Vite, hot reload)
pnpm --filter @xstate/web dev    # http://localhost:8785 (marketing site and docs)
```

`pnpm --filter @xstate/app preview` and `pnpm --filter @xstate/web preview` build `dist/` and serve it with Wrangler,
the way Cloudflare does.

Also in `.claude/launch.json` as `api`, `app`, `web` and `web-preview`. Copy `apps/api/.dev.vars.example` to `.dev.vars` for local secrets.

The dashboard is at http://localhost:8787/app/ once you are signed in. `/app/?demo` shows it with sample data, no
sign-in needed. Messages, secrets, billing, integrations and other members are sample data until their APIs exist
(see `apps/app/src/lib/sample.ts`).

```bash
pnpm --filter @xstate/desktop dev    # desktop app against the app dev server
pnpm --filter @xstate/desktop start  # desktop app from a fresh build of apps/app/dist, calling api.xstate.com
pnpm --filter @xstate/desktop dist   # installers in apps/desktop/dist (dmg/zip, nsis, AppImage)
```

Set `XSTATE_API_URL=http://localhost:8788/v1` to point `start` at a local API. If Electron complains its binary is
missing after install, run `node apps/desktop/node_modules/electron/install.js`. Auto-update reads the `publish` URL
in `apps/desktop/package.json`; point it at wherever release builds are uploaded.

## Background mail sync

Stalwart calls `POST /webhooks/stalwart` when mail arrives. The API queues a sync of that mailbox on the
`xstate-mail-sync` queue, which copies new attachments into the organization's R2 bucket. An hourly cron syncs
every mailbox in case webhooks were lost, and permanently removes files whose message was deleted more than 30
days ago. See `docs/stalwart-api.md` §7.

One-time production setup:

```bash
pnpm --filter @xstate/api exec wrangler queues create xstate-mail-sync
pnpm --filter @xstate/api exec wrangler secret put STALWART_WEBHOOK_SECRET   # also R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CLOUDFLARE_API_TOKEN
```

Then create the WebHook on Stalwart with the same secret (`docs/stalwart-api.md` §7). Locally,
`wrangler dev --test-scheduled` lets you run the hourly job with `curl "localhost:8788/__scheduled?cron=0+*+*+*+*"`.

## Deploy

Pushes to `main` run `.github/workflows/deploy.yml`: typecheck, then deploy `api`, `app` and `web` with `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` from the `production` environment. By hand:

```bash
pnpm --filter @xstate/api deploy
pnpm --filter @xstate/app deploy
pnpm --filter @xstate/web deploy
```

## Docs

Public docs are plain Markdown in `apps/web/content/docs`, one file per page, served at `xstate.com/docs/<file>`.
Each file needs a frontmatter `title` (and optionally `description`); `meta.json` sets the sidebar order. Every page
is also served as Markdown at `/docs/<page>.md`, and `/llms.txt` lists them all. The top-level `docs/` folder is
internal design notes, not published.
