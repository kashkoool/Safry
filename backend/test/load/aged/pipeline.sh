#!/usr/bin/env bash
# Builds one run from nothing: PostgreSQL container, migrations (timed), runtime login, aged seed (pnpm seed:history), actors for both
# databases (aged = safry, minimal = safry_fresh). Usage: bash pipeline.sh <a|b>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="${1:?a|b}"
OUT="$HERE/../.data/aged/out"
mkdir -p "$OUT"
bash "$HERE/infra.sh" "$RUN" down
bash "$HERE/infra.sh" "$RUN" up
bash "$HERE/infra.sh" "$RUN" migrate | tee "$OUT/migrate-$RUN.txt"
bash "$HERE/infra.sh" "$RUN" roles
bash "$HERE/seed.sh" "$RUN" | tee "$OUT/seed-$RUN.txt"
node "$HERE/actors.mjs" --run "$RUN" --db safry
node "$HERE/actors.mjs" --run "$RUN" --db safry_fresh
echo "pipeline $RUN done"
