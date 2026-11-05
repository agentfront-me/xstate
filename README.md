# xstate

Free business email with agents. A pnpm + Turborepo monorepo of Cloudflare Workers, laid out like upfold.

## Layout

| Path | Package | What it is |
| --- | --- | --- |
| `apps/api` | `@xstate/api` | Hono Worker: the HTTP API. |
| `apps/www` | `@xstate/www` | Static site at xstate.com, served as Worker assets: marketing, sign-up, and the dashboard at `/app/`. |
| `apps/desktop` | `@xstate/desktop` | Electron app that wraps the dashboard (bundles `apps/www/public`, served from `app://xstate`). |
| `packages/` | | Shared libraries (`@xstate/<name>`), added when needed. |
| `tooling/tsconfig` | `@xstate/tsconfig` | Shared TypeScript base config. |
| `docs/` | | Product docs and notes. |

## Develop

```bash
pnpm install
pnpm --filter @xstate/api dev    # http://localhost:8788/health
pnpm --filter @xstate/www dev    # http://localhost:8787
```

Also in `.claude/launch.json` as `api` and `www`. Copy `apps/api/.dev.vars.example` to `.dev.vars` for local secrets.

The dashboard is at http://localhost:8787/app/ once you are signed in. `/app/?demo` shows it with sample data, no
sign-in needed. Messages, secrets, billing, integrations and other members are sample data until their APIs exist
(see `apps/www/public/app/sample.js`).

```bash
pnpm --filter @xstate/desktop dev    # desktop app against the www dev server
pnpm --filter @xstate/desktop start  # desktop app from the bundled files, calling api.xstate.com
pnpm --filter @xstate/desktop dist   # installers in apps/desktop/dist (dmg/zip, nsis, AppImage)
```

Set `XSTATE_API_URL=http://localhost:8788/v1` to point `start` at a local API. If Electron complains its binary is
missing after install, run `node apps/desktop/node_modules/electron/install.js`. Auto-update reads the `publish` URL
in `apps/desktop/package.json`; point it at wherever release builds are uploaded.

## Deploy

Pushes to `main` run `.github/workflows/deploy.yml`: typecheck, then deploy `api` and `www` with `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` from the `production` environment. By hand:

```bash
pnpm --filter @xstate/api deploy
pnpm --filter @xstate/www deploy
```
