# Domain Connect (one-click DNS setup)

With Domain Connect, a domain whose DNS is on Cloudflare can add all of xstate's mail records in one click. In
onboarding step 3 ("Verify your domain"), a **Connect with Cloudflare** button sends the owner to Cloudflare, they
approve, and Cloudflare sends them back to `/signup`, which picks up at the verify step again. The records table
stays underneath as the fallback.

Cloudflare supports only the **synchronous** flow, and only for templates that are signed, merged into the public
Templates repo, and onboarded by Cloudflare. Until those steps are done the API returns `applyUrl: null` and
onboarding looks the same as it does today.

## What's in the repo

| Piece | Where |
| --- | --- |
| Template (`<providerId>.<serviceId>.json`) | [`xstate.io.mail.json`](xstate.io.mail.json) |
| Discovery, signing, apply link | [`apps/api/src/mailserver/domain-connect.ts`](../../apps/api/src/mailserver/domain-connect.ts), `domainConnectUrl` in [`domains.ts`](../../apps/api/src/mailserver/domains.ts) |
| API operation | `email_domain_connect_url`, `GET /v1/email/domains/:domainId/domain-connect?redirectUri=…` → `{ applyUrl, provider }` |
| Tests (signature checked against OpenSSL) | `pnpm --filter @xstate/api test` |
| Key pair generator | [`apps/api/scripts/domain-connect-key.sh`](../../apps/api/scripts/domain-connect-key.sh) |
| Onboarding button and return handling | [`apps/app/src/onboarding/VerifyStep.tsx`](../../apps/app/src/onboarding/VerifyStep.tsx) and `state.ts` |
| Switch | `DOMAIN_CONNECT_ENABLED` in [`apps/api/wrangler.jsonc`](../../apps/api/wrangler.jsonc) (now `"false"`) |

The template sets:

- **MX** `@` → `mx.xstate.io`, priority 10. Cloudflare replaces any existing MX records, after showing the owner.
- **SPFM** `@` with rule `mx`. Cloudflare merges it into the existing SPF record instead of adding a second one.
  The DNS check accepts a merged SPF (for example `v=spf1 mx include:_spf.google.com ~all`) as long as it has `mx`.
- **CNAME** `%dkim1%._domainkey` → `%dkim1%.dkim.amazonses.com`, and the same for `dkim2` and `dkim3`: the three SES
  Easy DKIM tokens. The API fills them in from the domain's SES tokens and returns no link until SES has issued them.
- **TXT** `_dmarc` → `v=DMARC1; p=reject; rua=mailto:postmaster@%domain%`.

How a link is built: the API looks up the domain's `_domainconnect` TXT record (Cloudflare's is
`api.cloudflare.com/client/v4/dns/domainconnect`), reads `GET https://<that>/v2/<domain>/settings` to get
`urlSyncUX` (`https://dash.cloudflare.com/domainconnect`), and asks `urlAPI` whether our template is onboarded. Then it
signs the query with RSA-SHA256:

```
{urlSyncUX}/v2/domainTemplates/providers/xstate.io/services/mail/apply
  ?domain=…&dkim1=…&dkim2=…&dkim3=…&redirect_uri=…&state=<domain id>&key=_dck1&sig=…
```

The signature covers everything before `&key=`. `sig` is always the last parameter. `redirect_uri` is signed only when
it's on one of `APP_ORIGINS`, so our signature can't be used for an open redirect. The desktop app (`app://xstate`)
sends no redirect: it opens Cloudflare in the browser and keeps checking DNS.

Linter result: `dc-template-linter -cloudflare xstate.io.mail.json` exits 0. It gives one info note (DCTL5008):
Cloudflare doesn't support `txtConflictMatchingMode`. The DMARC record keeps it because other providers use it to
replace an existing DMARC record instead of adding a second one. The linter has no releases, so build it with Go:
`go install github.com/Domain-Connect/dc-template-linter@latest`.

## Your checklist

### 1. Publish the public key

A key pair was generated on 2026-11-06. The private key is at `~/.config/xstate/domain-connect_dck1.key`, outside
the repo. Add these **two TXT records** in Cloudflare on the `xstate.io` zone, both named `_dck1` (one value each):

```
p=1,a=RS256,d=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA61UV8dxb7RzbzF6xEisqtkUA+gTJYSclPYEAofLgiCgpGzdmH2IXu5ImJNS/+guPwxM1EN5AYGzFTDuDXap23oaKoo0yHWMFOISvK2T9TyHdmt1/zPHHNpaKFiuDLWKv5Sde+1UiOCv+bPBloEmK/+C091y/
p=2,a=RS256,d=NvmyXU6IHG3Yp1IipFRHaQvA6Mu21ptHpeoR/sYe125Rygd3ptHL4PCKfaUT33OVbqC8MuH5KgHtaNEB9gpGGUZx6hMDrLCob06QpmU4k4Pep+mM0NMc1FEL1wnLrF4YUWsh1BVTs0VGULHbY6bmNP3mrFWTg4tMrdpwcG310dBikbv92quMv32VAwIDAQAB
```

Check that both are published:

```bash
dig +short TXT _dck1.xstate.io
```

Then store the private key as a Worker secret:

```bash
cd apps/api && wrangler secret put DOMAIN_CONNECT_PRIVATE_KEY < ~/.config/xstate/domain-connect_dck1.key
```

Back up that key file somewhere safe, such as a password manager. To rotate, run
`apps/api/scripts/domain-connect-key.sh _dck2`, publish `_dck2`, put the new secret, then change
`DOMAIN_CONNECT_KEY_HOST`.

### 2. Publish the SVG logo

The template's `logoUrl` is `https://xstate.com/brand/logo.svg`: the "x/s" mark on the dark rounded square, with
the letters as outlines (Inter Regular), so it looks the same on Cloudflare's approval page everywhere. Deploy the
website, then check that the URL loads before you open the PR.

### 3. Open the PR to the Templates repo

1. Fork https://github.com/Domain-Connect/Templates.
2. Copy `docs/domain-connect/xstate.io.mail.json` to the root of the fork, under the same file name.
3. Lint it: `dc-template-linter -cloudflare xstate.io.mail.json`.
4. Open the PR. Say that it's a mail template (MX, SPFM, SES DKIM CNAMEs, DMARC), that requests are signed
   (`syncPubKeyDomain: xstate.io`, key `_dck1`), and that Cloudflare is the first DNS provider you're targeting.

### 4. Email Cloudflare

Send this to **domain-connect@cloudflare.com** once the PR is open (merged is better):

- **Template link:** the PR, or the merged file at
  `https://github.com/Domain-Connect/Templates/blob/master/xstate.io.mail.json`
- **Public key FQDN:** `_dck1.xstate.io` (`syncPubKeyDomain` `xstate.io`, key host `_dck1`)
- **SVG logo:** `apps/web/public/brand/logo.svg`, attached, and https://xstate.com/brand/logo.svg
- **Proxy default:** DNS only. These are mail records: MX and TXT can't be proxied, and the DKIM CNAMEs must
  resolve to `dkim.amazonses.com` unproxied.
- **Test account ID:** the Cloudflare account to enable the template on first, for testing. It could be the account
  that holds `asif.co`. Its ID is on the right side of any zone's Overview page.

### 5. Turn it on

When Cloudflare confirms:

1. Set `"DOMAIN_CONNECT_ENABLED": "true"` in `apps/api/wrangler.jsonc` and deploy the API.
2. Test with `asif.co` (DNS on Cloudflare): in onboarding step 3, **Connect with Cloudflare** should appear. Approve
   the records, and you should land back on step 3 with the records showing as found.
3. To check from the command line, call `GET /v1/email/domains/<id>/domain-connect` with a session token. It should
   return a non-null `applyUrl` that starts with `https://dash.cloudflare.com/domainconnect/v2/domainTemplates/…`.
