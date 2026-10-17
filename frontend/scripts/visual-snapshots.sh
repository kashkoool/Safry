#!/usr/bin/env bash
# Runs (or updates) the visual-regression screenshots inside the same Playwright image CI uses, so the PNGs are
# byte-comparable with CI. Never generate them on Windows or macOS: font rendering differs and CI would fail.
#   scripts/visual-snapshots.sh            compare against the committed snapshots
#   scripts/visual-snapshots.sh --update   rewrite frontend/e2e/__screenshots__ (review the diff, then commit)
# The image tag must match "@playwright/test" in package.json and the "visual.yml" workflow.
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: do not rewrite the container paths
HERE="$(pwd -W 2>/dev/null || pwd)"
IMAGE="mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f" # same tag and digest as visual.yml
MODE="${1:-}"
case "$MODE" in ""|--update) ;; *) echo "usage: $0 [--update]" >&2; exit 2;; esac
UPDATE=""; [ "$MODE" = "--update" ] && UPDATE="--update-snapshots"
mkdir -p e2e/__screenshots__ test-results
NAME="safry-more-visual-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
# The sources are copied into the container (no node_modules from the host); only the snapshot folder is writable.
docker run --rm --name "$NAME" --ipc=host \
  -v "$HERE":/src:ro \
  -v "$HERE/e2e/__screenshots__":/out \
  -e UPDATE="$UPDATE" \
  "$IMAGE" bash -ec '
    mkdir /work && cd /src && tar cf - --exclude=node_modules --exclude=dist --exclude=test-results --exclude=playwright-report . | tar xf - -C /work
    cd /work
    # exact pnpm with integrity hashes (tools/pnpm/package-lock.json), same as the Dockerfile
    mkdir -p /opt/pnpm && cp tools/pnpm/package.json tools/pnpm/package-lock.json /opt/pnpm/ && npm ci --ignore-scripts --no-audit --no-fund --prefix /opt/pnpm >/dev/null
    ln -s /opt/pnpm/node_modules/.bin/pnpm /usr/local/bin/pnpm
    pnpm install --frozen-lockfile >/dev/null
    cp -r /out/. e2e/__screenshots__/ 2>/dev/null || true
    E2E_PROJECTS=visual E2E_BASE_URL=http://127.0.0.1:55526 E2E_API_URL=http://127.0.0.1:55516 CI=1 pnpm exec playwright test $UPDATE --reporter=list || RC=$?
    if [ -n "$UPDATE" ]; then rm -rf /out/* ; cp -r e2e/__screenshots__/. /out/; fi
    exit ${RC:-0}
  '
