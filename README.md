# xstate

Free business email with agents. A pnpm + Turborepo monorepo of Cloudflare Workers, laid out like upfold.

## Layout

| Path | Package | What it is |
| --- | --- | --- |
| `apps/api` | `@xstate/api` | Hono Worker: the HTTP API. |
| `apps/www` | `@xstate/www` | Static marketing site at xstate.com, served as Worker assets. |
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

## Deploy

Pushes to `main` run `.github/workflows/deploy.yml`: typecheck, then deploy `api` and `www` with `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` from the `production` environment. By hand:

```bash
pnpm --filter @xstate/api deploy
pnpm --filter @xstate/www deploy
```
