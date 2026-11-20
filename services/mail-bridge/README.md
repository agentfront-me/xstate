# mail-bridge

Lets mail apps reach xstate (`docs/imap-smtp-relay-plan.md`, 3.1). It listens on the mail ports, ends TLS, and copies
bytes to and from one WebSocket per connection at `wss://api.xstate.com/relay/imap` or `/relay/smtp`. It doesn't read
IMAP or SMTP, writes nothing to disk, and logs only counts, sizes and addresses. It goes away when Cloudflare Workers
accept inbound TCP.

## Build

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o mail-bridge .
```

deepo is x86_64 (Amazon Linux 2023). One static binary; nothing else to install.

## Install on deepo

1. DNS: `mail.xstate.com` A record → deepo's IP, **DNS only**.
2. AWS security group: open TCP 993, 465 and 587 to the world.
3. Certificate: an nginx server block for `mail.xstate.com` on port 80 that serves
   `/.well-known/acme-challenge/` from `/var/www/letsencrypt`, then
   `sudo certbot certonly --webroot -w /var/www/letsencrypt -d mail.xstate.com`, with a deploy hook in
   `/etc/letsencrypt/renewal-hooks/deploy/` that copies `fullchain.pem` and `privkey.pem` to `/etc/mail-bridge/`
   (owner `mail-bridge`, mode 600), and `certbot-renew.timer` enabled. The bridge re-reads the certificate when the
   file changes, so renewals need no restart. (A Cloudflare Origin CA certificate won't do: mail apps don't trust it.)
4. User and files:
   ```bash
   sudo useradd --system --no-create-home --shell /sbin/nologin mail-bridge
   sudo install -d -o mail-bridge -g mail-bridge -m 700 /etc/mail-bridge
   sudo install -o root -g root -m 755 mail-bridge /usr/local/bin/mail-bridge
   sudo install -o root -g root -m 644 mail-bridge.service /etc/systemd/system/mail-bridge.service
   ```
5. Secret: the same long random string in `/etc/mail-bridge/secret` (owner `mail-bridge`, mode 600) and in the
   Worker's `RELAY_SECRET` (`wrangler secret put RELAY_SECRET`).
6. `sudo systemctl daemon-reload && sudo systemctl enable --now mail-bridge`

Logs: `journalctl -u mail-bridge -f`. A `stats` line every minute gives open connections and memory.

## Run locally

Start the API with the `api-relay` launch configuration (port 8826), then:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj "/CN=localhost"
BRIDGE_SECRET=local-relay-secret go run . -upstream ws://localhost:8826/relay -cert cert.pem -key key.pem -imaps 127.0.0.1:1993 -submission 127.0.0.1:1587
```

## Frames

Binary frames carry the connection's bytes, both ways. Text frames are control:

- bridge → session `ack <n>`: the mail app has taken `n` bytes in total. Sent every 256 KB. The session sends at
  most 1 MB ahead of the last ack, so a slow mail app can't fill its memory.
- session → bridge `close`: close the connection once everything sent before it is written.
