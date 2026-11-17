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
- Apex (`example.com`), groups `mail` and `dmarc`: [Test xstate.io/mail example.com/@](https://domainconnect.paulonet.eu/dc/free/templateedit?token=H4sIAL32%2B2oC%2F%2B1WbU%2FjRhD%2BK6uVED1dYhw7JMGUitdW12soAqpDQijaeNfJEtvr7K6TGER%2Fe2fXCXEgJW3VD5zEhyj2zjzzzMzOix%2BxZkkWE81w8IgzKSacMvmF4gDPlIZjhwtcexack4Q9i%2BBcMTnhIbP6CeHx8mhFE3VL2YRJxUWKA6%2BGYzEQf8gYdIZaZyrY2ZkThiLZ6UuS0h2j4qjJAJCUqVDyTFs0vmJaoTxDBFEBtCmKhERzqn6ueMqUQsw4FKDuDdICJTPnOZ4aurr4uYb0kMFPMoaOEvIgUnR1doXOiCrQ6dcvXXRyftQ9U%2BgHkeu%2ByFOKjDnEFZIsJgWjCDxEig9SeOwXBvzJHhF02j26PEGZiHlYOOgXKcDTbYPeRkMRU2WZuzfWDQuxfJKFQlK1jwYlgCZEhlVEabZUszDwJWaRRuAhmg5ZarXmCSGxZIQWaEgUEilzTPKJ5KQfs9OVVNIRTxo1ZP688s8PKoa21Vs50mLEUsgRcwYOamb3s364G3tR1h6PZq2HUTRI6EBx%2F37sSUk%2FOYAMh6gPESRMoR8t%2BienVzKNWFHm%2FFlgnHGI5VVMmbowYagiDY9jEY5wEJFYsfLkIu9%2FZcWptfSido34klEOmdMvFcBmbTqdOpVXKLnlG8CHQulLNs4BT58p55eFg9tHbO%2Br2gG6yEzpd2%2FmaHg%2BND0keKrVtTCKlWq03cWF5LrAQcMFuIam8Fuu%2B1T7e%2BNQOt1V8yqLLvOYKWsev4W1WV6Ct2wJbFXuYdXZhfz1deB%2F6Ow6Qm8Dofd%2FE%2FobCP1%2FR2jbc8l4fXO95OsthJRoAu%2BTA9u7jX2UHUh2D3W4j2RODozTWgQZoBKiNJOHW6WHW1VeeJzpE5FGME90l%2BhwyNNBV1BDeyFZxGd4rcpctqTHT3dPNQzBsd6yfu%2FAy0VTsBmBXVAtfDiEJxt1j1v9RabLEAGdEUkSZbbHws7tiqG7haVbbJ6trXV2bJUZwaY5slD2jHJbj8Z%2Bkk692XB30g%2BbslU83HdonLkqGhDWWCj7RnnkDenetCln43byoHf7qR9OilZ0H6tOBsouNvmBiS4k65nJTnQuIcta5tDySR5r3iNTsjyiYY9kWVxAOhVIgQLGQbX703IJHi5L4UXnVy55dQj0aGhSyk2pNULColbbrbvNll9vhmG7Tpq0XW%2B293zWIZ7f8FhlR79a3muW9PJuYVOyVHNiFvFRPCWFwk%2Bm0lfq%2BnUckwOYNw1Yq%2BhPEseLSCCQd%2BT7YgrMvd9UV6vjYR7nRtDbM%2BPdJmNT36xNxkbQd5qMTXNhbTI2gr6XZKy0%2BH9fXavL493EeVeDFfcxlj%2FG8sdY%2FhjLH2P53Yxl%2BC5XZMJojxg1z%2FVa9Uaj3mhfu63A3wt2247X8Tp7rc%2BuG7iucZ0pXUb%2FCF%2Fp1e9zXByH5y6Zfpte9h9%2Bu6CfT4%2FSXcpmv38bH0dd3chG16Pz5CY9%2B9XrHOCnvwDI5i2Y8xIAAA%3D%3D)
- Subdomain (`example.com`, host `mail`), groups `mail` and `dmarc`: [Test xstate.io/mail example.com/mail](https://domainconnect.paulonet.eu/dc/free/templateedit?token=H4sIANv2%2B2oC%2F%2B1XbU%2FjRhD%2BKytLiJ6aGMfOG6ZUR3lp0TUUCEioJxRtvONkE9trdjcvBtHf3lk7IQ4H5Cr1wyHxIYq9M8%2B87cwzyYOlIU4jqsHyH6xUiilnIE%2BZ5VtzpfHY5sKqPAnOaAxPIjxXIKc8gFw%2FpjxaHa1pkk4hm4JUXCSW71asSAzEtYxQZ6h1qvydnYXDQMQ7fUkTtmNUbDUdIJKBCiRPdY62uqAVmaSEEibQbUJCIcnCVX%2BieAJKETAB%2BaRzQ7Qg8dx%2ByqdCuucnFaKHgB8JQA5iei8S0j3ukmOqMnL05bRDDs8OOseK%2FCQmui8mCSPGHOGKSIhoBoxghETxQYKP%2FcyAP%2BVHlBx1Di4PSSoiHmQ2%2BV0KjHTboLfJUERM5Z47N3kYOST3JyEQkqk9MigALKYyKCMKs4VaDsNYIgg1wQjJbAhJrrUoCI0kUJaRIVVEJGCb4lPJaT%2BCo7VSsjGPaxVivtziy%2FNLhrbVWzXSYgwJ1gjsgU3q6WjeDxqRG6atu%2FG8eT8OBzEbKO6N7lwp2ScbkcGQ9DGDGBT5JUf%2FavcKT2PIipo%2FCUwwNs39KlCmL0waKkuC3yIRjC0%2FpJGC4uR80v8C2VFu6VnvGvElMI6V088V0GZlNpvZpVdsudUbwodC6Uu4myCePblcXJblf32w8vsqT4DOUtP6nZsFGp8%2FmxkSPNHqShjFUjfm08WF5Dqz%2FJqDcI1D4TUd57HyunFsnc66eZWGl5MIVG7eegubV3kF3spbYKt0D%2BvBLuXfXof1ncG%2B5NDd4ND9vx16Gxx6%2F81hPp4rj1c3Vyt%2FvaWQUU3xfbqfz25tj6T7EkbYh3tETui%2BCVoLP0VUTJUG%2BXmriHCr7Bcf5%2FpQJCHyie5QHQx5MugIZtyeSwj53HpRZSFbubcebx8rFiYHvVX%2F3mKUy6GAOcVdUG78VWXzzHs8xyzPijTRQkoljZXZIEtbX9eM3S6tLaC3C3sv2cq7zQg28clS2TXKLT2%2B8%2BJk5s6HjWk%2FqMtmdj9qsyh1VDigUFsqe0Z57A7Z7qwu53et%2BF43%2BokXTLNmOIpUO0VlxzJ1QmYXEnqG4ameSKy2lhMc%2FXgSad6jM7o6YkGPpmmUYVkVStEF0kKZBZJiGS5TLbriGQmU7nudD3osMJXlpuvCEMDbpVCttb12tc48qFKv3a5SaDvQouFuGAaldf3NHn9hX69fMy5OSDSnZi8fRDOaKevRNP5am7%2BYznQfGaiGi5b8Q6NomRDm84OlsOSGRRKbuqxEGvZ6whuRb9PJD12VTeP0elU2It9xVTbxxutV2Yh8T1VZI4Fi19nPueB7F976yvmhEr6t4HL8IPIPIv8g8g8i%2FyDyd0zk%2BNtf0SmwHjWqruM2q7Vatda6cpp%2B3fHdlt1oNFu11s%2BO4zuOCR%2BULirwgP8Eyv8BrOGFEJD80R3%2FdX0SjbtpN7hoKOSNvzuHo6t6Mv7zXvTPjk5PmtcX%2B9bjvwt2xf9fEwAA)
- Apex, group `mail` only (the domain already has DMARC; no `_dmarc` record is written): [Test xstate.io/mail example.com/@, group mail only](https://domainconnect.paulonet.eu/dc/free/templateedit?token=H4sIAOv2%2B2oC%2F%2B1WbW%2FiRhD%2BKytLUXo6cGwMhnOaKq%2BtrifucgmnphdFaPEOsMH2OrtrwInS395ZG4JJ0tBK%2FZCT8gFh78wzz8zsvPjO0hCnEdVgBXdWKsWUM5AfmRVYc6Xx2ObCqj0IPtMYHkR4rkBOeQiFfkx5tDpa0yTdUjYFqbhIrKBRsyIxEt9khDpjrVMV7OwsCEMR7wwkTdiOUbHVdIRIBiqUPNUF2joHrUiWEkqYQNqEDIUkC6pBpngCShEwDgWke0G0IPHcfoinRs5Pf60RPQb8SQByENNbkZDzk3NyQlVOjj997JKjzwfdE0V%2BEpkeiCxhxJgjXBEJEc2BEfSQKD5K8HGQG%2FC74oiS4%2B7B2RFJRcTD3Ca%2FSYGebhv0NhmLiKmCuXtRuFFACj4JoZBM7ZJRCWAxlWEVUZot1QoY%2BhLBUBP0kMzGkBRai4TQSAJlORlTRUQCtkk%2BlZwOIjheSyWb8NitEfPXKP%2B8oGJoW72UIy0mkGCOwB7ZpJlezwdhK2oM0%2FbNZO7fToajmI0U965vGlKydzYiwzEZYAQxKPJzgf7F7pdME8jLnD8IjDM2LXgVKFMXJgyVJ%2BFhJMKJFQxppKA8Oc0GnyA%2FLiw9ql0jPgPGMXP6sQLarM1mM7vyiiW3ekP4WCh9BjcZ4tkD5eKyrODyziruq9oBOk9N6XcvFmh83jc9JHiiVU8YxUo1Ft3FheQ6twLXQbjGpvB8x7mv%2FbNxLJ3uunmVDs%2ByCFRh3noJW2R5Bd4qSmCrcg%2Frzi7lT6%2FD%2BpfOPkfY2EDY%2BL8JvQ2E3n8jLNpzxdi76K34%2Bksho5ri%2B3Sv6F13l6R7Eq6xDneJzOiecVqLIEVUTJUGub9VerhV5cXHuT4SyRDnie5SHY55MuoKZmhPJQz53HpWZSFb0Vv3V%2Fc1C4OD%2Fqp%2Br9DLZVPAnOIuqBY%2BHuJTEXWfF%2FplphGVUkljZbbGEn%2B5ZuBqaeHSMs%2BFjSq%2BqCpzsGluLJUbRrmtJzdenMwa83FrOgib0s9vrzssSh01HFFwl8qeUZ40xuzDrCnnN%2B34VrcGiRdOc394HalOisqOZfKBE1xI6JtJTnUmMataZtjicRZp3qczujpiYZ%2BmaZRj%2BhRKkQLbv9rtSbn09ldX%2F6jTK5e63vR9FppUclNaHm0zz3W8uuO0wnqz5fn1DvhO3e1Aoxn60AEYVnbyk2X9zFJe3SVuRkg0p2bxHkQzmivr3lT2Wh0%2FjWO6h%2FPFxTVK%2FqJRtIwEA3lFvi%2B7fuH9prpaHweLODeCXp4RrzYZm%2Frm2WRsBP2gydg0F55NxkbQ607GVQ1H%2Fdu4ehtXb%2BPqbVz9AOMKv%2BMUnQLrU6PWcBp%2B3XXrbrvn%2BEHTCZqe7fhNx22%2Fd5zAcYzroHQZ%2Bx1%2B1VW%2F56wvnePWAf8a9T64h773Pmr9nv3pTs%2B%2Bfvk2%2F559n%2Fit3u3hydH4ovvHaM%2B6%2Fxvw0Q%2BtExEAAA%3D%3D)
