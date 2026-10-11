#!/usr/bin/env bash
# Starts the compiled API against the load-test database (run from backend/ after `pnpm build`).
# NODE_ENV=test is used only because it disables the in-memory throttler, as the integration tests do.
set -euo pipefail
export NODE_ENV="${NODE_ENV:-test}"
export PORT="${PORT:-3100}"
export DATABASE_URL="${LOAD_DATABASE_URL:-postgresql://safry:loadtest-only@127.0.0.1:55505/safry}"
export JWT_ACCESS_SECRET="${LOAD_JWT_SECRET:?set LOAD_JWT_SECRET (same value used by seed.mjs)}"
export DATABASE_RLS=on
export DATABASE_POOL_MAX="${DATABASE_POOL_MAX:-10}"
exec node "${MAIN:-dist/main.js}"
