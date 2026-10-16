#!/usr/bin/env bash
# OWASP ZAP baseline (passive, safe: it only spiders and observes responses) against a stack you started yourself.
#   scripts/dast-local.sh [target-url]      default http://host.docker.internal:8080 (the web container on the host)
# Start the stack first (docker compose up, or the "web" image as in docs/CI.md); never point this at production.
# To reach a container by name set DAST_NETWORK=<docker network> and pass http://<container>:8080.
# Output: .zap-report/report.html and report.json; exit code 1 on any Medium or higher alert (same gate as CI).
# The ZAP ACTIVE scan (zap-full-scan.py) sends attack traffic and creates junk data: run it only against a staging copy.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
ZAP_IMAGE="ghcr.io/zaproxy/zaproxy:2.17.0@sha256:7aaa659b0d43078febd82e29bad112285c370727e86ab8340444220e17d9f0d2" # keep equal to .github/workflows/dast.yml
TARGET="${1:-http://host.docker.internal:8080}"
HERE="$(pwd -W 2>/dev/null || pwd)"
OUT=".zap-report"
rm -rf "$OUT"; mkdir -p "$OUT"; chmod 777 "$OUT"
cp .zap/rules.tsv "$OUT/rules.tsv"
NAME="safry-more-zap-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
RC=0
NET=(--add-host host.docker.internal:host-gateway); [ -z "${DAST_NETWORK:-}" ] || NET=(--network "$DAST_NETWORK")
docker run --rm --name "$NAME" "${NET[@]}" -v "$HERE/$OUT":/zap/wrk:rw "$ZAP_IMAGE" \
  zap-baseline.py -t "$TARGET" -c rules.tsv -J report.json -r report.html -I -m 3 || RC=$?
# 0/1/2 are scan results (the gate below decides); anything else means ZAP itself failed.
[ "$RC" -le 2 ] || { echo "ZAP failed to run (exit $RC)" >&2; exit "$RC"; }
node scripts/dast-check.mjs "$OUT/report.json"
