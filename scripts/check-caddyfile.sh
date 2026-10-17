#!/bin/sh
# Adapts deploy/caddy/Caddyfile.cloudflare with the real Caddy image of docker-compose.yml and asserts, on the resulting JSON, that
# CF-Connecting-IP is believed in exactly one route, matched by remote_ip with the configured ranges, and that every other caller is
# keyed by its own connection address with the forged header removed. Also checks the file fails closed without the ranges.
#   sh scripts/check-caddyfile.sh        (needs docker and jq; exit 0 = all assertions hold)
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
image="$(grep -m1 -o 'caddy:[^ "]*' "$root/docker-compose.yml")"
[ -n "$image" ] || { echo "error: no caddy image in docker-compose.yml" >&2; exit 1; }
ranges="203.0.113.0/24 2001:db8:abcd::/48"

adapt() { # $1 = value of CLOUDFLARE_IP_RANGES
  docker run --rm -v "$root/deploy/caddy:/c:ro" -e SITE_ADDRESS=example.test -e CLOUDFLARE_IP_RANGES="$1" \
    "$image" caddy adapt --config /c/Caddyfile.cloudflare
}

json="$(adapt "$ranges" 2>/dev/null)" || { echo "FAIL: caddy adapt failed with ranges set"; adapt "$ranges"; exit 1; }

# Every reverse_proxy handler with its X-Forwarded-For value and deleted request headers.
proxies='[.. | objects | select(.handler? == "reverse_proxy") | {xff: (.headers.request.set["X-Forwarded-For"] // []), del: (.headers.request.delete // [])}]'
test "$(printf '%s' "$json" | jq "$proxies | map(select(.xff == [\"{http.request.header.CF-Connecting-IP}\"])) | length")" = 1 \
  || { echo "FAIL: CF-Connecting-IP must be used by exactly one reverse_proxy"; exit 1; }
test "$(printf '%s' "$json" | jq "$proxies | map(select(.xff == [\"{http.request.remote.host}\"] and (.del | index(\"CF-Connecting-IP\")))) | length")" = 1 \
  || { echo "FAIL: exactly one fallback must set X-Forwarded-For to remote_host and delete CF-Connecting-IP"; exit 1; }

# The route that trusts the header is the only remote_ip-matched route, and it carries exactly the configured ranges.
trusting='[.. | objects | select(has("match") and has("handle")) | select(any(.match[]?; has("remote_ip")))]'
test "$(printf '%s' "$json" | jq "$trusting | length")" = 1 || { echo "FAIL: expected exactly one remote_ip-matched route"; exit 1; }
test "$(printf '%s' "$json" | jq -c "$trusting | .[0].match[0].remote_ip.ranges")" = '["203.0.113.0/24","2001:db8:abcd::/48"]' \
  || { echo "FAIL: remote_ip ranges differ from CLOUDFLARE_IP_RANGES"; exit 1; }
test "$(printf '%s' "$json" | jq "$trusting | .[0] | [.. | objects | select(.handler? == \"reverse_proxy\" and (.headers.request.set[\"X-Forwarded-For\"] // []) == [\"{http.request.header.CF-Connecting-IP}\"])] | length")" = 1 \
  || { echo "FAIL: the remote_ip-matched route must contain the CF-Connecting-IP proxy"; exit 1; }

# Fail closed: without ranges adapt must fail, or no remote_ip matcher may carry any range (it then matches nobody).
if empty="$(adapt "" 2>/dev/null)"; then
  echo "note: adapt succeeds without ranges; remote_ip matchers produced:"
  printf '%s' "$empty" | jq -c '[.. | objects | select(has("remote_ip")) | .remote_ip]'
  test "$(printf '%s' "$empty" | jq '[.. | objects | select(has("remote_ip")) | .remote_ip.ranges // [] | length] | add // 0')" = 0 \
    || { echo "FAIL: ranges present although CLOUDFLARE_IP_RANGES is empty"; exit 1; }
else
  echo "ok: adapt refuses the file without CLOUDFLARE_IP_RANGES (fails closed)"
fi
echo "OK: Caddyfile.cloudflare behaves as designed ($image)"
