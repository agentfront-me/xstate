# Deploying the scan service

The scan service runs on the mail server, next to Stalwart. Stalwart hands it every message before accepting it
(an MTA hook), and the API sends it composer and Storage uploads. It checks attachments against the file-type
rules (`apps/api/src/security/attachments.ts`) and scans everything with ClamAV.

```
sending server ──SMTP──▶ Stalwart ──POST /hook──▶ scanner ──▶ clamd
API (Workers) ──HTTPS /_scan/scan (nginx)───────▶ scanner ──▶ clamd
```

## Before you start: memory

ClamAV keeps its signatures in memory: about 1 GB. The mail server needs **4 GB of RAM** to run it next to
Stalwart and Postgres (a t3.medium). Don't install it on 2 GB: the server will swap and mail will slow down.

## 1. ClamAV

Amazon Linux 2023 packages ClamAV **1.4 LTS** as `clamav1.4`. Don't use the plain `clamav` package there: it is
0.103, which is past its end of life.

```bash
sudo dnf install clamav1.4 clamd1.4 clamav1.4-freshclam
```

1. Append the settings in `clamd-scan.conf` to `/etc/clamd.d/scan.conf` (the package's file already has
   `LogSyslog` and `User`).
2. `sudo freshclam` downloads the signatures (about 110 MB on disk).
3. `sudo systemctl enable --now clamav-freshclam clamd@scan`. The first keeps the signatures updated; the second
   takes about a minute to load them, then `/run/clamd.scan/clamd.sock` appears.

## 2. The scanner

```bash
pnpm --filter @xstate/scanner build        # makes apps/scanner/dist/scanner.mjs, one file, no node_modules
```

On the server:

1. `useradd --system --no-create-home xstate-scanner`
2. Copy `dist/scanner.mjs` to `/opt/xstate-scanner/scanner.mjs`.
3. Write `/etc/xstate-scanner.env` (mode 600):
   ```
   SCAN_SECRET=<openssl rand -base64 32>
   CLAMD=/run/clamd.scan/clamd.sock
   SCAN_ENFORCE=false
   ```
4. Copy `xstate-scanner.service` to `/etc/systemd/system/`, then `systemctl enable --now xstate-scanner`.
5. `curl -s localhost:8765/health` shows `"ok":true` and the age of the signatures.
6. Add `nginx-scan.conf` to the mx.xstate.io server block, `nginx -t && systemctl reload nginx`. From your own
   machine, `curl https://mx.xstate.io/_scan/health` gives the same answer.

Test it with the EICAR file, a harmless file every antivirus reports:

```bash
printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > /tmp/eicar.txt
curl -s -H "Authorization: Bearer $SCAN_SECRET" --data-binary @/tmp/eicar.txt 'localhost:8765/scan?name=eicar.txt'
```

With `SCAN_ENFORCE=false` this answers `{"infected":false}` and logs `file-would-be-refused`
(`journalctl -u xstate-scanner`). With `true` it answers `{"infected":true,"virus":"…"}`.

## 3. Log-only week

Nothing is refused yet; the scanner logs what it would refuse.

```bash
# Stalwart: scan every message, but never hold mail up if the scanner fails
STALWART_URL=https://mx.xstate.io STALWART_API_KEY=… SCAN_SECRET=… \
  node apps/api/scripts/stalwart-scan-hook.mjs --log-only

# API: scan uploads, refuse nothing
wrangler secret put SCAN_SECRET          # the same value
# set "SCAN_MODE": "log" in apps/api/wrangler.jsonc, then deploy
```

Read the log after a few days: `journalctl -u xstate-scanner | grep would-be-refused`. Every line is a message or
file that will be refused once enforcing. Look for false alarms, mostly from the file-type rules (a customer who
really does mail `.js` files) and the phishing signatures.

## 4. Enforce

1. `/etc/xstate-scanner.env`: `SCAN_ENFORCE=true`, then `systemctl restart xstate-scanner`.
2. Run `stalwart-scan-hook.mjs` again **without** `--log-only`. From now on, if the scanner is down Stalwart
   answers `451 try again later` and sending servers retry, so nothing gets in unscanned.
3. `"SCAN_MODE": "live"` in `wrangler.jsonc`, deploy.

Refused mail gets a `550 5.7.1` reply during SMTP, so the sender's own server tells them why. Nothing is stored.

4. Update the public Security page (`apps/web/content/docs/security.md`): the Attachments section can now say
   that mail and uploads are virus-scanned, and that mail apps over IMAP no longer receive blocked files. Until
   this step the page rightly says the rules aren't a virus scan.

## Turning it off

`node apps/api/scripts/stalwart-scan-hook.mjs --remove` takes the hook out of Stalwart at once (settings are
reloaded, no restart). `"SCAN_MODE": "off"` stops the API scanning.

## Watching it

- `GET /health` fails (503) when clamd is down or the signatures are more than 48 hours old.
- The API checks it every hour and logs `scanner-unhealthy` (Workers logs) when it fails.
- A stopped scanner while enforcing shows up as `mta-hook.error` in Stalwart's log, and incoming mail is deferred.

## What isn't scanned

- Mail and files imported from Google Workspace: Google scanned them already. The file-type rules still apply
  when their attachments are copied and downloaded.
- Text saved from xstate's own editors and by agents (Markdown, CSV as text).
- Mail already in mailboxes before the hook was turned on.
