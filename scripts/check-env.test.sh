#!/bin/sh
# Self-test for check-env.sh: TRUST_PROXY with 2+ hops must not be combined with a publicly published web port.
#   sh scripts/check-env.test.sh        (exit 0 = all cases behave)
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
rnd() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }

# A valid base file: the example with every CHANGE_ME value replaced by a fresh random one.
base="$tmp/base.env"
while IFS= read -r line; do
  case "$line" in
    *=*CHANGE_ME*|*=*change_me*) printf '%s=%s\n' "${line%%=*}" "$(rnd)" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "$here/../docker.env.example" > "$base"

failures=0
# case <name> <expected exit> <expected output fragment or -> <extra env lines...>
check() {
  name="$1"; want="$2"; frag="$3"; shift 3
  { cat "$base"; for l in "$@"; do printf '%s\n' "$l"; done; } > "$tmp/case.env"
  out="$(sh "$here/check-env.sh" "$tmp/case.env" 2>&1)"; got=$?
  if [ "$got" != "$want" ] || { [ "$frag" != "-" ] && ! printf '%s' "$out" | grep -q "$frag"; }; then
    echo "FAIL $name: exit $got (want $want), output: $out"; failures=$((failures + 1))
  else echo "ok   $name"; fi
}

check "baseline passes"                                   0 "OK:"            
check "1 hop + public bind only warns"                    0 "WARN WEB_BIND"   TRUST_PROXY=1 WEB_BIND=0.0.0.0
check "2 hops + loopback bind (tls profile) passes"       0 "OK:"            TRUST_PROXY=2 WEB_BIND=127.0.0.1 SITE_ADDRESS=app.example.net
check "2 hops + public bind WITHOUT tls profile fails"    1 "FAIL WEB_BIND"   TRUST_PROXY=2 WEB_BIND=0.0.0.0
check "2 hops + public bind WITH tls profile fails"       1 "FAIL WEB_BIND"   TRUST_PROXY=2 WEB_BIND=0.0.0.0 SITE_ADDRESS=app.example.net
check "3 hops + public bind fails"                        1 "FAIL WEB_BIND"   TRUST_PROXY=3 WEB_BIND=10.0.0.5
check "explicit acknowledgement downgrades it to a warn"  0 "acknowledged"    TRUST_PROXY=2 WEB_BIND=0.0.0.0 ALLOW_PUBLIC_WEB_BIND_WITH_PROXY_HOPS=true
exit "$failures"
