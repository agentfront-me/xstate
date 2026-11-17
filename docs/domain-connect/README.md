# Domain Connect (one-click DNS setup)

With Domain Connect, a domain whose DNS is on Cloudflare can add all of xstate's mail records in one click. In
onboarding step 3 ("Verify your domain"), a **Connect with Cloudflare** button sends the owner to Cloudflare, they
approve, and Cloudflare sends them back to `/signup`, which picks up at the verify step again. The records table
stays underneath as the fallback.

Cloudflare supports only the **synchronous** flow, and only for templates that are signed, merged into the public
Templates repo, and onboarded by Cloudflare. Without a link the API returns `applyUrl: null` and onboarding shows
only the records table.

**Status (2026-11-17):** v1 is merged (Domain-Connect/Templates#2868). Cloudflare onboarded it in **test mode**: it
works only for our own Cloudflare account (`99322c1871edd6eb7fba729f872c1832`), so `DOMAIN_CONNECT_TEST_DOMAINS` is
`asif.co`. v2 (record groups, see below) is in this folder and needs its own PR; Cloudflare picks up template
updates automatically, with no new onboarding.

## What's in the repo

| Piece | Where |
| --- | --- |
| Template (`<providerId>.<serviceId>.json`) | [`xstate.io.mail.json`](xstate.io.mail.json) |
| Discovery, signing, apply link | [`apps/api/src/mailserver/domain-connect.ts`](../../apps/api/src/mailserver/domain-connect.ts), `domainConnectUrl` in [`domains.ts`](../../apps/api/src/mailserver/domains.ts) |
| API operation | `email_domain_connect_url`, `GET /v1/email/domains/:domainId/domain-connect?redirectUri=…` → `{ applyUrl, provider }` |
| Tests (signature checked against OpenSSL) | `pnpm --filter @xstate/api test` |
| Key pair generator | [`apps/api/scripts/domain-connect-key.sh`](../../apps/api/scripts/domain-connect-key.sh) |
| Onboarding button and return handling | [`apps/app/src/onboarding/VerifyStep.tsx`](../../apps/app/src/onboarding/VerifyStep.tsx) and `state.ts` |
| Switches | `DOMAIN_CONNECT_ENABLED` (now `"true"`) and `DOMAIN_CONNECT_TEST_DOMAINS` (now `"asif.co"`) in [`apps/api/wrangler.jsonc`](../../apps/api/wrangler.jsonc) |

The template (version 2) has two record groups:

- Group **`mail`**, always applied:
  - **MX** `@` → `mx.xstate.io`, priority 10. Cloudflare replaces any existing MX records once the owner approves,
    so mail stops reaching the old server straight away. The API returns those old hosts as `replacesMx`, and
    onboarding says so under the Connect button.
  - **SPFM** `@` with rule `mx`. Cloudflare merges it into the existing SPF record instead of adding a second one,
    and the result always ends in `~all`, even when the old record ended in `-all`. The DNS check accepts a merged
    SPF (for example `v=spf1 mx include:_spf.google.com ~all`) as long as it has `mx`.
  - **CNAME** `%dkim1%._domainkey` → `%dkim1%.dkim.amazonses.com`, and the same for `dkim2` and `dkim3`: the three
    SES Easy DKIM tokens. The API fills them in from the domain's SES tokens and returns no link until SES has
    issued them.
- Group **`dmarc`**: **TXT** `_dmarc` → `v=DMARC1; p=reject; rua=mailto:postmaster@%domain%`. Applied only when
  `_dmarc.<domain>` has no `v=DMARC1` record. Cloudflare ignores `txtConflictMatchingMode`, so it would add ours
  next to an existing one, and receivers treat two DMARC records as no policy at all. The API looks the record up
  and sends `groupId=mail` or `groupId=mail,dmarc`. The conflict-matching fields stay for providers that use them.

How a link is built: the API looks up the domain's `_domainconnect` TXT record (Cloudflare's is
`api.cloudflare.com/client/v4/dns/domainconnect`), reads `GET https://<that>/v2/<domain>/settings` to get
`urlSyncUX` (`https://dash.cloudflare.com/domainconnect`), and asks `urlAPI` whether our template is onboarded. Then it
signs the query with RSA-SHA256:

```
{urlSyncUX}/v2/domainTemplates/providers/xstate.io/services/mail/apply
  ?domain=…&dkim1=…&dkim2=…&dkim3=…&groupId=mail,dmarc&redirect_uri=…&state=<domain id>&key=_dck1&sig=…
```

The signature covers everything before `&key=`. `sig` is always the last parameter. `redirect_uri` is signed only when
it's on one of `APP_ORIGINS`, so our signature can't be used for an open redirect. The desktop app (`app://xstate`)
sends no redirect: it opens Cloudflare in the browser and keeps checking DNS.

Linter: `dc-template-linter -cloudflare xstate.io.mail.json`. On v1 Cloudflare's run gave only info notes:
DCTL5003 (Cloudflare ignores `syncRedirectDomain`), DCTL5008 (it ignores conflict matching) and DCTL5011 (it
ignores `essential`). v2 drops `essential`, so expect only the first two. The linter has no releases, so build it
with Go: `go install github.com/Domain-Connect/dc-template-linter@latest`.

## Your checklist

Done: the key pair (`_dck1.xstate.io`, private key at `~/.config/xstate/domain-connect_dck1.key` and in the Worker
secret `DOMAIN_CONNECT_PRIVATE_KEY`), the logo at https://xstate.com/brand/logo.svg, the v1 PR, and Cloudflare's
onboarding in test mode.

To rotate the key: run `apps/api/scripts/domain-connect-key.sh _dck2`, publish `_dck2`, put the new secret, then
change `DOMAIN_CONNECT_KEY_HOST`.

### 1. Open the v2 PR to the Templates repo

1. In your fork of https://github.com/Domain-Connect/Templates, sync with upstream and copy
   `docs/domain-connect/xstate.io.mail.json` over the file at the root.
2. Lint it: `dc-template-linter -cloudflare xstate.io.mail.json`.
3. Make fresh test links in the [Online Editor](https://domainconnect.paulonet.eu/dc/free/templateedit) and paste
   them into [`pr-description.md`](pr-description.md), then open the PR with it.

### 2. Test on asif.co

Deploying the API (push to main) turns the button on for `asif.co` only. Until v2 is merged and Cloudflare has it,
links ask for groups v1 doesn't have; test after the merge.

1. asif.co has no DMARC record now. In onboarding step 3, **Connect with Cloudflare** should appear with a warning
   that mail stops going to `mx.asif.co`. Approve: all six records should be added, and step 3 should show them found.
2. Then check the DMARC case: change `_dmarc.asif.co` to another `v=DMARC1` value, remove our other records, and
   connect again. Cloudflare should leave `_dmarc` alone, with only one DMARC record afterwards.
3. From the command line: `GET /v1/email/domains/<id>/domain-connect` with a session token returns an `applyUrl`
   starting with `https://dash.cloudflare.com/domainconnect/v2/domainTemplates/…` and `replacesMx`.

### 3. Go live

Email domain-connect@cloudflare.com (reply to Enrique's thread) that testing is done and ask them to set the
template live. When they confirm, set `"DOMAIN_CONNECT_TEST_DOMAINS": ""` in `apps/api/wrangler.jsonc` and deploy.
