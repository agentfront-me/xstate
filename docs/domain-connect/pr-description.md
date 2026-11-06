# Description

New template for xstate (https://xstate.com), a business email service. It points a domain's mail at xstate:
MX to `mx.xstate.io`, SPF through `SPFM` (rule `mx`), the three Amazon SES Easy DKIM CNAMEs (outbound mail is
relayed and DKIM-signed by Amazon SES), and a DMARC policy.

Requests are signed: `syncPubKeyDomain` is `xstate.io` and the public key is published at `_dck1.xstate.io`. The
first DNS provider we're onboarding with is Cloudflare.

Variables: `dkim1`, `dkim2`, `dkim3` are the domain's SES Easy DKIM tokens. Each is used only inside a fixed
pattern: host `%dkimN%._domainkey`, target `%dkimN%.dkim.amazonses.com`.

## Type of change

Please mark options that are relevant.

- [x] New template
- [ ] Bug fix (non-breaking change which fixes an issue in the template)
- [ ] New feature (non-breaking change which adds functionality to the template)
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
- [x] `essential` is set to `OnApply` on records the end user may need to modify or remove without breaking the template (e.g. DMARC)

## Online Editor test results

**Editor test link(s):**
- Apex (`example.com`): [Test xstate.io/mail example.com/@](https://domainconnect.paulonet.eu/dc/free/templateedit?token=H4sIANJq7WoC%2F%2B1Wa2%2FbNhT9KwSBYCsmy3rYbq3OQ7w4RRtDbR5ekSEIDEqiZcaSqJCUHwm8395L2fIjMVps%2B7AWCwFB1H3xHvLcSz1iRdM8IYpi7xHngk9ZRMWHCHt4LhWITcaxsVF8JCndqEAuqZiykJb2KWHJVrRnifyVbkqFZDzDnm3ghMf8D5GAzVipXHr1%2BnrBkKf1QJAsqmsTU05j8IyoDAXLVemNr6iSqMgRQRGHZTM04gKtlwoKyTIqJaI6IQ%2F510hxlM7NDR4DXZ2%2FM5AaU3gEpaibkgeeoavTK3RK5AL1%2Bh98dPKx659K9DMvVMCLLEI6HGISCZqQBY0QZIgkizOYBgvt%2FKoUEdTzu5cnKOcJCxemRk0EI0FCe3sYoglLbQPpl7N6uV6Z0wrST%2FJrySk%2BoRkkR83YRI38bh6EzcQZ5a%2FvJ%2FPWw2QUp1EsmXt37wgRvTLBMxyjgMLWUol%2BLb1%2FM4erlSZ0sQK7UehkTFKuK6nUB6JhyEUW%2Fp7wcIK9EUkkXUnOi6BPF70y0hPSaPUljZigoXpqADGN2Wxmbj%2FBYcyluqT3BXhEm0XAm4tIYu%2FmEatFrknlX6%2BNYX6s2clZpuSAaxLunHPJW8YFUwtgnGVgpYBubsuylsYmFlDB348m89FlkVBZRsM7puUmbW2PyhM82tnG%2FVQq%2FfPdxIdTORTf%2BUZ851%2FGd78R3%2F0b8QfXg230YZQSEerKJYrA97RTloX9FuUdQe%2BAEm%2BRKEhHV5XiXg5eKZGKiuOjVT5Hu6sYGCqaZooR3TA%2BZd08T3S6aq5OeDaCSlM%2BUeGYZbHPI53MuaAjNj9sstZtk8LL26WBASAdbul2C7lXrKVzAl1yl6cghFkseJEPWWWfE0FSqTtp5Xmz53pb%2Bd5gPS8Joj8IDBtGJXS0MIDhwKiErhaGMFwYWCcMzYcLOtRNiKhCAGwlCiiZtEgUG5IZ2YqicEj0ngE%2BCVoI9aScslW%2FPt6e2JNS2jmL%2FaoaRqFGzPQdQKKR025ZzZrdJm9qjWbzTY24jlOzSOA67mvXihqjnevk2T1z4D7ZbvYuBbrJjCwkXj6j33Mc0w5UtA03APqLJEmFBIB8R7lXpbnOvuLDfm2u8WyUXy%2FM7xZcxeuD4DbKHxRcVZ8HwW2UPwq4vZL65x19v3v%2B1zir22O5vDWgab%2F0wZc%2B%2BNIHX%2Frg%2F7kPwh%2BmJFMaDYm2cyynVbPtmtUaWE2vaXt2w2y3rXaj%2BYtleZalc6dSreA%2Fwn%2Fo7h8ofnh%2F0X03FmefxwN%2F%2FBD3zy6a7V5ybs9PLqjbvqjHn%2Fv9wJ%2F2z8Z%2FdvDyC5QKufKAEAAA)
- Subdomain (`example.com`, host `mail`): [Test xstate.io/mail example.com/mail](https://domainconnect.paulonet.eu/dc/free/templateedit?token=H4sIAP9q7WoC%2F%2B1WbU%2FbSBD%2BK6uV0F1Vx3HskIB7OTUH6V1BaRFQCQmhaG1PwhLba3bXIQblfntn7TgvQNur7guVWCVyMm87z%2B4zM36gGpIsZhqo%2F0AzKWY8Avkxoj6dK41imwtqrRSfWAIrFcoVyBkPobRPGI%2FXoi1LMqx0M5CKi5T6LYvGYiK%2ByBhtrrXOlN9sLjcMRdIMJEujpjGx1WyCnhGoUPJMl970DLQieUYYiQRum5KxkGS5VZArnoJSBExCPhleEC1IMrdXeCxydvLBIvoa8CsBSD9h9yIlZ4MzMmCqIIfHH4fk4FN%2FOFDkd5HrQORpREw4whWRELMCIoIZEsUnKf4MCuP8phQxcjjsnx6QTMQ8LGyDmknOghgOtzBEU560LGIebvXw%2FDKnCtJv6nvJaTGFFJMDe2KTdnYzD8Ld2B1n3dvpvHM%2FHU%2BSaKK4d3PrShm9sdEzvCYB4NGCIn%2BU3n%2Fao2qnKRQV2JXCJGOzcl8FylyIgaGKNPwrFuGU%2BmMWK6gkJ3lwDMVhGekRaYz6FCIuIdSPDTCmdXd3Z6%2F%2FosO1UPoUbnP0iFaboLeQkaL%2B5QPVRWZINbxYGuPv94adgqdanQtDwo17LnnLheS6QMY5FtUa6eZ1HGdhrWIhFYbb0VQ2Ps1jUGU0umFaHtLadqe8wZ2NY9xOpdY%2FPU36fCrPxXd%2FEN%2F9n%2FG9H8T3fiL%2B%2BcX5OvooSpgMTeUyzfD%2FrFeWResdyXoSbpAS74jMWc9UlRZ%2Bhl4JUxrk%2B50qn53NXSyKFQ2p5sw0jM9pP8tik66e6wORjrHS9JDp8Jqnk6GITDInEsZ8%2FrzJUrdOii6uFhZFgDBa0%2B0Kc69ZC3OGXXKTp%2BuGN5Eiz0a89smYZIky3bT2vtxyv6r9L6sAZhtDFCNguFq4aqFrhAEuF1ct9IwwxOXhoiZxbEJCwsg0I6ZzifC1zLF0kjzWfMTu2FoUhSNmzg5xKtRiqEdllVZ9e4lteXmPqmrjWrYLbBSFBjg342Af9rvt0IMGc%2Fa6jba3GzT2xmOn0e22gv3QbXtu0NmYLE9GzjOjZfvcNxnRj%2B9YoejiCRufhTPrYY23cCaQf1kc14AQzwuDUBfsEkTNjo2KtbeBrSy%2BX7MvGmVN92%2BjXFn8wijr%2Bv02ypXFr4Ryq%2BiqEWA%2Frr3%2FOge2e%2B5LAFzPncXiysJW%2F9o5Xzvna%2Bd87ZyvnfNnOie%2BxSo2g2jEjK3ruJ1Gq9VwOufOrr%2Fb8nf3bbfTxs9bx%2FEdx%2BQPSldH8IDvuptvudQ7OhqcdaB57%2F4z%2FLs4Pd47b%2Ba8%2F%2BHkS%2FJWSHXS6hweDfRN8wbYoEcXXwGCG2%2Bd7BAAAA%3D%3D)
