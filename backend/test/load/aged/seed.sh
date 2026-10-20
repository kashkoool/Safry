#!/usr/bin/env bash
# Seeds ~26 months of history (pnpm seed:history, default scale: ~5k users, 50k bookings) into database safry of run <a|b>,
# and the minimal demo data into safry_fresh. Prints the size report afterwards.
set -euo pipefail
RUN="${1:?a|b}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$HERE/../../.."
# shellcheck disable=SC1090
. "$HERE/../.data/aged/$RUN.env"
if [ "$RUN" = a ]; then PGPORT=55621; else PGPORT=55622; fi
export TZ=UTC PGTZ=UTC
cd "$BACKEND"
URL="postgresql://safry:$OWNER_PW@127.0.0.1:$PGPORT/safry"
s=$(date +%s)
pnpm seed:history -- --url "$URL" --anchor "${SEED_ANCHOR:-2026-10-20}" 2>&1 | tail -20
e=$(date +%s)
echo "seed wall time: $((e - s)) s"
pnpm db:size-report -- --url "$URL" --partitions 2>&1 | tail -60
