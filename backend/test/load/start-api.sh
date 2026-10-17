#!/usr/bin/env bash
# Starts the compiled API against the load-test database (run from backend/ after `pnpm build`).
# LOAD_LIMITER=off (default): NODE_ENV=test, which disables the in-memory rate limiter, as the integration tests do.
# LOAD_LIMITER=on: NODE_ENV=development, so the rate limiter, the per-user limit and the refresh limits are all active,
#   and TRUST_PROXY=1 (default) so the client address comes from X-Forwarded-For, as behind the reverse proxy. Console mail transport.
set -euo pipefail
if [ "${LOAD_LIMITER:-off}" = "on" ]; then
  export NODE_ENV=development
  export TRUST_PROXY="${TRUST_PROXY:-1}"
  export MAIL_TRANSPORT="${MAIL_TRANSPORT:-console}"
else
  export NODE_ENV="${NODE_ENV:-test}"
fi
export PORT="${PORT:-3100}"
export DATABASE_URL="${LOAD_DATABASE_URL:?set LOAD_DATABASE_URL (runtime login of the load-test database)}"
export JWT_ACCESS_SECRET="${LOAD_JWT_SECRET:?set LOAD_JWT_SECRET (same value used by seed.mjs)}"
export DATABASE_RLS=on
export DATABASE_POOL_MAX="${DATABASE_POOL_MAX:-10}"
exec node "${MAIN:-dist/main.js}"
