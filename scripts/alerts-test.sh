#!/usr/bin/env bash
# Checks and unit-tests the Prometheus alert rules with promtool from the official Prometheus image (needs Docker only).
#   bash scripts/alerts-test.sh
# Works in Git Bash on Windows and on Ubuntu. Nothing is pushed or deployed; the container is removed afterwards.
set -euo pipefail

# Pinned by tag and digest. Dependabot (docker ecosystem, /scripts/alerts) can bump both together.
PROM_IMAGE="${PROM_IMAGE:-prom/prometheus:v3.5.1@sha256:38c3b05c3bc744ff1b0b7b4eb82196026442845e62a1e2073795565da506d7a2}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
alerts_dir="$(cd "$here/../deploy/alerts" && pwd)"
# Git Bash would rewrite /rules style paths; keep them untouched.
export MSYS_NO_PATHCONV=1
# On Windows Git Bash, docker needs a native path for the volume source.
mount_src="$alerts_dir"
if command -v cygpath >/dev/null 2>&1; then mount_src="$(cygpath -m "$alerts_dir")"; fi

run() {
  docker run --rm --entrypoint promtool -v "$mount_src:/rules:ro" -w /rules "$PROM_IMAGE" "$@"
}

echo "== every metric the rules use is exported by backend/src/common/http/metrics.ts"
metrics_src="$here/../backend/src/common/http/metrics.ts"
missing=0
for name in $(grep -v '^[[:space:]]*#' "$alerts_dir/safry.rules.yml" | grep -oE 'safry_[a-z0-9_]+' | sed -E 's/_(bucket|sum|count)$//' | sort -u); do
  if ! grep -q "$name" "$metrics_src"; then echo "MISSING in metrics.ts: $name"; missing=1; fi
done
[ "$missing" = 0 ] || exit 1

echo "== promtool check rules"
run check rules safry.rules.yml
echo "== promtool test rules"
run test rules safry.rules.test.yml
echo "alert rules: OK"
