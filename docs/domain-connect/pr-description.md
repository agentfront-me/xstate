# Description

Version 2 of the xstate mail template (xstate.io/mail), already onboarded at Cloudflare.

- Records are now in two groups: `mail` (MX, SPFM, the three SES DKIM CNAMEs) and `dmarc` (the DMARC TXT). We
  apply `dmarc` only when the domain has no DMARC record yet. Cloudflare doesn't support `txtConflictMatchingMode`,
  so without groups an existing DMARC record would get a second one next to it, and receivers treat two as no
  policy. Cloudflare honours `groupId`.
- `essential` removed from the DMARC record: with the group the owner's existing record is kept anyway.
- `go.xstate.com` added to `syncRedirectDomain`: our app moved there, and it is where the flow now returns.

Unchanged: `syncPubKeyDomain` `xstate.io`, key `_dck1`, the variables `dkim1`..`dkim3` (each only inside a fixed
pattern: host `%dkimN%._domainkey`, target `%dkimN%.dkim.amazonses.com`), and the logo.

## Type of change

Please mark options that are relevant.

- [ ] New template
- [x] Bug fix (non-breaking change which fixes an issue in the template)
- [x] New feature (non-breaking change which adds functionality to the template)
- [ ] Breaking change (fix or feature that would cause existing template behavior to be not backward compatible)

# How Has This Been Tested?

Please mark the following checks done
- [x] Template functionality checked using [Online Editor](https://domainconnect.paulonet.eu/dc/free/templateedit)
- [x] Template file name follows the pattern `<providerId>.<serviceId>.json`
- [x] resource URL provided with `logoUrl` is actually served by a webserver

# Checklist of common problems

Mark all the checkboxes after conducting the check. Comment on any point which is not fulfilled.
See [Template Quality Guidelines](../README.md#template-quality-guidelines) for details and rationale on each rule.

- [x] `syncPubKeyDomain` is set — **this is mandatory**; omitting it requires explicit justification in the PR description or the PR will be rejected
- [x] `warnPhishing` is **not** set alongside `syncPubKeyDomain` — the two must not appear together
- [x] `syncRedirectDomain` is set whenever the template uses `redirect_uri` in the synchronous flow
- [x] no TXT record contains SPF content (`"v=spf1 ..."`) — use the `SPFM` record type instead
- [x] `txtConflictMatchingMode` is set on every TXT record that must be unique per label or content prefix (e.g. DMARC)
- [x] no variable is used as a bare full record value (e.g. `@ TXT "%foo%"`) unless necessary — prefer `@ TXT "service-foo=%foo%"`; if bare, justify in the PR description
- [x] no bare variable is used as the full `host` label — the non-variable parts are fixed to limit misuse (e.g. `%dkimkey%._domainkey`, not `%dkimhost%`); if bare, justify in the PR description
- [x] no variable is used in the `host` field to create a subdomain — use the `host` parameter or `multiInstance` instead
- [x] `%host%` does not appear explicitly in any `host` attribute
- [ ] `essential` is set to `OnApply` on records the end user may need to modify or remove without breaking the template (e.g. DMARC): not set. DMARC is in its own group, which we leave out when the domain already has one, so the owner's record is never replaced; Cloudflare doesn't support `essential` (linter DCTL5011).

## Online Editor test results

**Editor test link(s):**
- Apex (`example.com`): TODO, make a new link for v2
- Subdomain (`example.com`, host `mail`): TODO, make a new link for v2
