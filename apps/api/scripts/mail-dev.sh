#!/usr/bin/env bash
# A local Stalwart mail server for development, so `wrangler dev` never touches the production one (mx.xstate.io).
#
#   pnpm mail:dev     start it in the foreground (first run downloads Stalwart and sets it up)
#   pnpm mail:reset   stop it and delete its data, accounts and settings (keeps the downloaded binary)
#
# Everything lives in apps/api/.stalwart/ (git-ignored). The first run:
#   1. downloads Stalwart (same version as production), checking the release's SHA-256;
#   2. bootstraps it for mx.xstate.test with RocksDB on disk and no TLS certificate request;
#   3. moves its listeners to localhost-only dev ports and sends all outbound mail to a dead relay, so nothing is
#      ever delivered to real outside addresses (it stays in the queue, then bounces back to the sender). The spam
#      filter is off, so test mail from made-up senders lands in the inbox;
#   4. creates an API key and a mail-sync webhook to the local API, and writes STALWART_URL and STALWART_API_KEY
#      into apps/api/.dev.vars.
#
# Ports (127.0.0.1 only): HTTP/JMAP + admin UI 18080, SMTP 2525, SMTP submission (TLS) 2465, IMAP (TLS) 2993.
# Test inbound mail with e.g.: swaks --server 127.0.0.1:2525 --to someone@acme.test --from me@example.com

set -euo pipefail

VERSION=1.0.2
API_DIR=$(cd "$(dirname "$0")/.." && pwd)
DIR=$API_DIR/.stalwart
BIN=$DIR/bin/stalwart
CONFIG=$DIR/config.json
ADMIN=$DIR/admin.env
DEV_VARS=$API_DIR/.dev.vars

HTTP_PORT=18080
SETUP_PORT=18081
HOSTNAME_=mx.xstate.test
DOMAIN=xstate.test
API_URL=http://localhost:8788

log() { printf '\033[1mmail-dev:\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mmail-dev:\033[0m %s\n' "$*" >&2; exit 1; }

# --- Binary ------------------------------------------------------------------------------------------------------

release_asset() {
  local arch os
  case "$(uname -m)" in arm64 | aarch64) arch=aarch64 ;; x86_64) arch=x86_64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  case "$(uname -s)" in Darwin) os=apple-darwin ;; Linux) os=unknown-linux-gnu ;; *) die "unsupported OS $(uname -s)" ;; esac
  echo "stalwart-$arch-$os.tar.gz"
}

# SHA-256 of each v1.0.2 release asset, as published on GitHub.
release_sha256() {
  case "$1" in
    stalwart-aarch64-apple-darwin.tar.gz) echo 2df2c6ccd2b79ffb47f1be30268c4e977c7576c2044b28b72bc7695e71e45292 ;;
    stalwart-x86_64-apple-darwin.tar.gz) echo 569e58a07a6dbdd2e5325149b632dd858337c0b956f620ce8b6081402f6a7da6 ;;
    stalwart-aarch64-unknown-linux-gnu.tar.gz) echo 79864acfd055d8fba52e636cde4821453669a0cc222975a607d392740be8fdae ;;
    stalwart-x86_64-unknown-linux-gnu.tar.gz) echo 10bd375d4541e2ffbafdfd5d97d8aa1a5c188438fd8700fbd6f076ee0fc2f24f ;;
  esac
}

download() {
  [ -x "$BIN" ] && return
  local asset tmp got
  asset=$(release_asset)
  log "downloading Stalwart $VERSION ($asset)"
  mkdir -p "$DIR/bin"
  tmp=$(mktemp -d)
  curl -fsSL "https://github.com/stalwartlabs/stalwart/releases/download/v$VERSION/$asset" -o "$tmp/$asset"
  got=$( (shasum -a 256 "$tmp/$asset" 2>/dev/null || sha256sum "$tmp/$asset") | cut -d' ' -f1)
  [ "$got" = "$(release_sha256 "$asset")" ] || { rm -rf "$tmp"; die "checksum mismatch for $asset"; }
  tar xzf "$tmp/$asset" -C "$DIR/bin" stalwart
  chmod +x "$BIN"
  rm -rf "$tmp"
}

# --- Talking to it -----------------------------------------------------------------------------------------------

# jmap <port> <user:password> <methodCalls JSON>
jmap() {
  curl -fsS -u "$2" "http://127.0.0.1:$1/jmap/" -H 'Content-Type: application/json' \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":$3}"
}

# Fails with the response when any method call returned an error or left something not created/updated.
check() {
  python3 -c '
import json, sys
r = json.load(sys.stdin)
for name, res, _ in r["methodResponses"]:
    bad = name == "error" or any(res.get(k) for k in ("notCreated", "notUpdated", "notDestroyed"))
    if bad: sys.exit(f"{name}: {json.dumps(res)}")
'
}

wait_port() {
  for _ in $(seq 1 60); do
    curl -s -o /dev/null "http://127.0.0.1:$1/" && return
    sleep 0.25
  done
  die "Stalwart didn't open port $1 (see $DIR/logs/)"
}

# start_bg <env assignments...>: starts Stalwart in the background with extra environment variables.
start_bg() {
  mkdir -p "$DIR/logs"
  env "$@" "$BIN" --config="$CONFIG" >>"$DIR/logs/setup.out" 2>&1 &
  PID=$!
}

PID=
stop_bg() {
  [ -n "$PID" ] || return 0
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  PID=
}
# A failed setup step must not leave a background Stalwart running, or a half-written config behind.
trap 'status=$?; stop_bg; if [ $status -ne 0 ] && [ "${SETTING_UP:-}" = 1 ]; then rm -rf "$CONFIG" "$ADMIN" "$DIR/data"; log "setup failed, cleaned up; run it again"; fi' EXIT

ensure_not_running() {
  # Already up (e.g. a second `pnpm dev`): nothing to do. Exiting 0 keeps turbo from failing the whole dev run.
  if pgrep -f "$BIN --config" >/dev/null; then log "Stalwart is already running on http://localhost:$HTTP_PORT"; exit 0; fi
  local port
  for port in "$HTTP_PORT" "$SETUP_PORT" 2525 2465 2993; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then die "port $port is already in use: $(lsof -nP -iTCP:"$port" -sTCP:LISTEN | awk 'NR==2 {print $1, "pid", $2}')"; fi
  done
}

# --- First-run setup ---------------------------------------------------------------------------------------------

setup() {
  local recovery webhook_secret api_key
  recovery="admin:$(openssl rand -hex 16)"
  SETTING_UP=1
  mkdir -p "$DIR/data" "$DIR/logs"

  log "bootstrapping $HOSTNAME_"
  start_bg STALWART_RECOVERY_ADMIN="$recovery" STALWART_RECOVERY_MODE_PORT="$SETUP_PORT"
  wait_port "$SETUP_PORT"
  local bootstrap
  bootstrap=$(python3 -c '
import json, sys
dir = sys.argv[1]
print(json.dumps([["x:Bootstrap/set", {"update": {"singleton": {
    "defaultHostname": sys.argv[2], "defaultDomain": sys.argv[3],
    "requestTlsCertificate": False, "generateDkimKeys": True,
    "dataStore": {"@type": "RocksDb", "path": dir + "/data/"},
    "tracer": {"@type": "Log", "path": dir + "/logs/", "prefix": "stalwart.log", "rotate": "daily", "ansi": False,
               "multiline": False, "enable": True, "level": "info", "lossy": False, "events": {}, "eventsPolicy": "exclude"},
}}}, "a"]]))' "$DIR" "$HOSTNAME_" "$DOMAIN")
  jmap "$SETUP_PORT" "$recovery" "$bootstrap" | python3 -c '
import json, sys
res = json.load(sys.stdin)["methodResponses"][0][1]
creds = res.get("updated", {}).get("singleton") or sys.exit(f"bootstrap failed: {json.dumps(res)}")
print("ADMIN_USER=" + creds["username"] + "\nADMIN_PASSWORD=" + creds["secret"])' >"$ADMIN"
  chmod 600 "$ADMIN"
  stop_bg

  # Recovery mode opens no mail ports, so the defaults (25, 443, 465, 993, 995, 4190, 8080) are never bound.
  # Like listeners, Stalwart only adds its default routes when there are none, so "local" is created here too.
  # Production treats port 25 as the inbound port (no sign-in needed); here that's 2525. The spam filter is off:
  # test senders (someone@example.com) have no SPF or DKIM, so everything would land in Junk.
  log "moving listeners to localhost dev ports, routing outbound mail nowhere"
  start_bg STALWART_RECOVERY_MODE=1 STALWART_RECOVERY_ADMIN="$recovery" STALWART_RECOVERY_MODE_PORT="$SETUP_PORT"
  wait_port "$SETUP_PORT"
  # Stalwart creates its default listeners on the first normal start only if none exist, so creating these four
  # first means the defaults are never added.
  jmap "$SETUP_PORT" "$recovery" '[["x:NetworkListener/set",{"create":{
    "http":{"name":"http","protocol":"http","bind":{"127.0.0.1:18080":true},"useTls":true,"implicitTls":false},
    "smtp":{"name":"smtp","protocol":"smtp","bind":{"127.0.0.1:2525":true},"useTls":true,"implicitTls":false},
    "submissions":{"name":"submissions","protocol":"smtp","bind":{"127.0.0.1:2465":true},"useTls":true,"implicitTls":true},
    "imaps":{"name":"imaps","protocol":"imap","bind":{"127.0.0.1:2993":true},"useTls":true,"implicitTls":true}
  }},"l"]]' | check
  jmap "$SETUP_PORT" "$recovery" '[
    ["x:MtaRoute/set",{"create":{"local":{"@type":"Local","name":"local","description":"Local delivery route"},"r":{"@type":"Relay","name":"nowhere","description":"Local dev: outbound mail is never delivered","host":"127.0.0.1","port":9,"protocol":"smtp","implicitTls":false,"allowInvalidCerts":true}}},"r"],
    ["x:MtaStageAuth/set",{"update":{"singleton":{"require":{"match":{},"else":"local_port != 2525"},"saslMechanisms":{"match":{"0":{"if":"local_port != 2525 && is_tls","then":"[plain, login, oauthbearer, xoauth2]"}},"else":"false"}}}},"a"],
    ["x:MtaStageEhlo/set",{"update":{"singleton":{"rejectNonFqdn":{"match":{"0":{"if":"local_port == 2525","then":"true"}},"else":"false"}}}},"e"],
    ["x:SpamSettings/set",{"update":{"singleton":{"enable":false}}},"sp"],
    ["x:MtaOutboundStrategy/set",{"update":{"singleton":{"route":{"match":{"0":{"if":"is_local_domain(rcpt_domain)","then":"'"'"'local'"'"'"}},"else":"'"'"'nowhere'"'"'"}}}},"s"]
  ]' | check
  stop_bg

  # API key and webhook need a real account, so this step runs in normal mode (on the dev ports set above).
  # shellcheck disable=SC1090
  . "$ADMIN"
  log "creating the API key and the mail-sync webhook"
  start_bg
  wait_port "$HTTP_PORT"
  api_key=$(jmap "$HTTP_PORT" "$ADMIN_USER:$ADMIN_PASSWORD" '[["x:ApiKey/set",{"create":{"k":{"description":"xstate API (local dev)"}}},"k"]]' |
    python3 -c '
import json, sys
res = json.load(sys.stdin)["methodResponses"][0][1]
print(res.get("created", {}).get("k", {}).get("secret") or sys.exit(f"API key failed: {json.dumps(res)}"))')
  webhook_secret=$(dev_var STALWART_WEBHOOK_SECRET)
  if [ -n "$webhook_secret" ]; then
    jmap "$HTTP_PORT" "$ADMIN_USER:$ADMIN_PASSWORD" "$(python3 -c '
import json, sys
print(json.dumps([["x:WebHook/set", {"create": {"w": {
    "url": sys.argv[1] + "/webhooks/stalwart", "enable": True, "level": "info", "eventsPolicy": "include",
    "events": {"message-ingest.ham": True, "message-ingest.spam": True,
               "message-ingest.imap-append": True, "message-ingest.jmap-append": True},
    "signatureKey": {"@type": "Value", "secret": sys.argv[2]},
    "throttle": 1000, "discardAfter": 3600000, "lossy": False, "timeout": 10000}}}, "w"]]))' "$API_URL" "$webhook_secret")" | check
  else
    log "STALWART_WEBHOOK_SECRET isn't set in .dev.vars, so no webhook (mail sync then only runs hourly)"
  fi
  stop_bg

  set_dev_var STALWART_URL "http://localhost:$HTTP_PORT"
  set_dev_var STALWART_API_KEY "$api_key"
  log "wrote STALWART_URL and STALWART_API_KEY to .dev.vars (restart wrangler dev to pick them up)"
  SETTING_UP=
}

# --- .dev.vars ---------------------------------------------------------------------------------------------------

dev_var() {
  [ -f "$DEV_VARS" ] || return 0
  sed -n "s/^$1=//p" "$DEV_VARS" | tail -1 | tr -d '"'
}

set_dev_var() {
  [ -f "$DEV_VARS" ] || cp "$API_DIR/.dev.vars.example" "$DEV_VARS"
  python3 - "$DEV_VARS" "$1" "$2" <<'EOF'
import re, sys
path, name, value = sys.argv[1:]
text = open(path).read()
line = f"{name}={value}"
pattern = re.compile(rf"^{re.escape(name)}=.*$", re.M)
text = pattern.sub(lambda _: line, text, count=1) if pattern.search(text) else text.rstrip("\n") + "\n" + line + "\n"
open(path, "w").write(text)
EOF
}

RESET_SQL="DELETE FROM files; DELETE FROM mailbox_sync; DELETE FROM mailbox_access; DELETE FROM addresses;
DELETE FROM mailboxes; DELETE FROM email_events; DELETE FROM suppressions; DELETE FROM domains;
UPDATE members SET permissions = jsonb('{\"org\":[],\"domains\":{}}') WHERE role NOT IN ('owner', 'admin');"

# --- Commands ----------------------------------------------------------------------------------------------------

case "${1:-start}" in
  start)
    ensure_not_running
    download
    [ -f "$CONFIG" ] || setup
    # shellcheck disable=SC1090
    . "$ADMIN"
    log "Stalwart $VERSION on http://localhost:$HTTP_PORT (admin UI: $ADMIN_USER, password in .stalwart/admin.env)"
    log "SMTP 127.0.0.1:2525, submission 2465, IMAP 2993. Outbound mail is never delivered. Ctrl-C to stop."
    exec "$BIN" --config="$CONFIG"
    ;;
  reset)
    pkill -f "$BIN --config" 2>/dev/null && sleep 1 || true
    rm -rf "$CONFIG" "$ADMIN" "$DIR/data" "$DIR/logs"
    log "deleted local Stalwart data and settings"
    # Domains and mailboxes in the local D1 point at Stalwart ids that no longer exist (and would clash with the
    # new server's), so clear them. Users and organizations stay.
    if (cd "$API_DIR" && npx wrangler d1 execute xstate --local --command "$RESET_SQL" >/dev/null 2>&1); then
      log "cleared domains, mailboxes and mail data from the local D1 (users and organizations kept)"
    else
      log "couldn't clear the local D1; run: rm -rf $API_DIR/.wrangler/state/v3/d1 && pnpm db:migrate:local"
    fi
    ;;
  *)
    die "usage: mail-dev.sh [start|reset]"
    ;;
esac
