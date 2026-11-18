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

## Mail

Mail is received by Amazon SES, which saves it to S3 and notifies `POST /webhooks/ses-inbound`; the `xstate-mail-in`
queue delivers it into each mailbox's store (a Durable Object, `apps/api/src/mailbox/`). Sending goes straight
through SES. See `docs/mailbox-store-plan.md`.

Locally, `SES_MODE=fake` (in `.dev.vars`) logs outgoing mail instead of sending it, and received mail is posted
with `node apps/api/scripts/mail-in-fake.mjs --to someone@acme.test`. `wrangler dev --test-scheduled` runs the
hourly clean-up with `curl "localhost:8788/__scheduled?cron=0+*+*+*+*"`.

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
