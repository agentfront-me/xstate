#!/usr/bin/env bash
# Makes the RSA key pair that signs Domain Connect apply links (docs/domain-connect/README.md).
#
#   scripts/domain-connect-key.sh [key-host] [out-dir]
#
# key-host defaults to _dck1 (DOMAIN_CONNECT_KEY_HOST); out-dir defaults to ~/.config/xstate, outside the repo so the
# private key can't be committed. Prints the TXT records to publish at <key-host>.xstate.io and the command that
# stores the private key as a Worker secret. Refuses to overwrite an existing key: rotate with a new key-host
# (_dck2, …) so links signed with the old key keep verifying until the switch.
set -euo pipefail

host="${1:-_dck1}"
dir="${2:-$HOME/.config/xstate}"
key="$dir/domain-connect$host.key"

if [[ -e "$key" ]]; then
  echo "$key already exists. Use a new key host (e.g. _dck2) to rotate." >&2
  exit 1
fi

mkdir -p "$dir"
umask 077
# PKCS#8 PEM, then the base64 body on one line: the format DOMAIN_CONNECT_PRIVATE_KEY takes.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | grep -v -- '-----' | tr -d '\n' >"$key"
public=$(
  { echo '-----BEGIN PRIVATE KEY-----'; fold -w 64 "$key"; echo; echo '-----END PRIVATE KEY-----'; } |
    openssl pkey -pubout 2>/dev/null | grep -v -- '-----' | tr -d '\n'
)

echo "Private key (one line, PKCS#8): $key"
echo
echo "Publish these TXT records at $host.xstate.io (one record per line, DNS only):"
i=1
while [[ -n "$public" ]]; do
  echo "  p=$i,a=RS256,d=${public:0:200}"
  public="${public:200}"
  i=$((i + 1))
done
echo
echo "Then store the private key for the Worker:"
echo "  wrangler secret put DOMAIN_CONNECT_PRIVATE_KEY < $key"
