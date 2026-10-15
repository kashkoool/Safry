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
IMAGE="mcr.microsoft.com/playwright:v1.64.0-noble"
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
    npm install -g pnpm@11 >/dev/null 2>&1
    pnpm install --frozen-lockfile >/dev/null
    cp -r /out/. e2e/__screenshots__/ 2>/dev/null || true
    E2E_PROJECTS=visual E2E_BASE_URL=http://127.0.0.1:55526 E2E_API_URL=http://127.0.0.1:55516 CI=1 pnpm exec playwright test $UPDATE --reporter=list || RC=$?
    if [ -n "$UPDATE" ]; then rm -rf /out/* ; cp -r e2e/__screenshots__/. /out/; fi
    exit ${RC:-0}
  '
