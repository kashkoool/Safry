#!/bin/sh
# Self-test for backend/scripts/backup/backup.sh: the size cap, the age limit, "never delete the newest", the loud failure and the
# metrics file. pg_dump / pg_dumpall are replaced by stubs, so no database is needed.
#   sh scripts/backup-cap.test.sh        (exit 0 = all cases behave)
set -u
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../backend/scripts/backup/backup.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin"; mkdir -p "$bin"
# Stub dump: writes DUMP_KB kilobytes to the --file= path, or fails when STUB_FAIL=1.
cat > "$bin/pg_dump" <<'EOF'
#!/bin/sh
[ "${STUB_FAIL:-0}" = "1" ] && { echo "pg_dump: could not write (stub)" >&2; exit 1; }
for a in "$@"; do case "$a" in --file=*) f="${a#--file=}";; esac; done
head -c "$(( ${DUMP_KB:-100} * 1024 ))" /dev/zero > "$f"
EOF
cat > "$bin/pg_dumpall" <<'EOF'
#!/bin/sh
echo "CREATE ROLE stub;"
EOF
chmod +x "$bin/pg_dump" "$bin/pg_dumpall"

failures=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; failures=$((failures + 1)); }
dumps() { ls -1 "$1" | grep -c '^safry-.*\.dump$'; }
# old DIR STAMP KB DAYS_OLD: a pre-existing backup set
old() {
  head -c "$(( $3 * 1024 ))" /dev/zero > "$1/safry-$2.dump"; echo x > "$1/safry-$2.dump.sha256"; echo x > "$1/roles-$2.sql"
  touch -d "@$(( $(date +%s) - $4 * 86400 ))" "$1/safry-$2.dump" "$1/safry-$2.dump.sha256" "$1/roles-$2.sql"
}
run() { # run DIR [env...]
  d="$1"; shift
  ( export PATH="$bin:$PATH" DATABASE_MIGRATE_URL=postgresql://stub BACKUP_DIR="$d"; for e in "$@"; do export "$e"; done; sh "$script" ) 2>&1
}

# 1. Cap: with a 100 MB cap and 40 MB dumps, only the newest two sets fit; the oldest are deleted, the new one is kept.
d="$tmp/cap"; mkdir -p "$d"
old "$d" 20260101T000000Z 40960 5; old "$d" 20260102T000000Z 40960 4; old "$d" 20260103T000000Z 40960 3
out="$(run "$d" BACKUP_MAX_TOTAL_MB=100 DUMP_KB=40960)"; code=$?
[ "$code" = 0 ] && ok "cap run succeeds" || bad "cap run exit $code: $out"
[ "$(dumps "$d")" = "2" ] && ok "cap keeps exactly the two newest dumps" || bad "cap kept $(dumps "$d") dumps"
[ ! -e "$d/safry-20260101T000000Z.dump" ] && [ ! -e "$d/roles-20260101T000000Z.sql" ] && ok "oldest set (dump, checksum, roles) is gone" || bad "oldest set still there"
ls "$d" | grep -q '^safry-2026.*Z.dump$' && [ -e "$d/safry-20260103T000000Z.dump" ] && ok "previous newest dump is kept" || bad "previous newest dump missing"
newest="$(ls -1 "$d" | grep '^safry-.*\.dump$' | sort | tail -n 1)"
[ "$newest" != "safry-20260103T000000Z.dump" ] && ok "the freshly written dump is the newest and kept" || bad "new dump missing"

# 2. A cap smaller than one dump never deletes the newest, and says so loudly.
d="$tmp/tiny"; mkdir -p "$d"
old "$d" 20260101T000000Z 2048 2
out="$(run "$d" BACKUP_MAX_TOTAL_MB=100 DUMP_KB=204800)"; code=$?
[ "$(dumps "$d")" = "1" ] && ok "only the newest dump is left when it alone exceeds the cap" || bad "kept $(dumps "$d") dumps"
printf '%s' "$out" | grep -q "WARNING" && ok "exceeding the cap warns" || bad "no warning: $out"

# 3. Failure to write the new dump is loud, keeps the old dumps and records the failure.
d="$tmp/fail"; mkdir -p "$d"
old "$d" 20260101T000000Z 1024 1
out="$(run "$d" STUB_FAIL=1)"; code=$?
[ "$code" != 0 ] && printf '%s' "$out" | grep -q "BACKUP FAILED" && ok "failed dump exits non-zero and says BACKUP FAILED" || bad "failed dump exit $code: $out"
[ -e "$d/safry-20260101T000000Z.dump" ] && ok "older dump survives a failed run" || bad "older dump deleted by a failed run"
[ -z "$(ls "$d" | grep partial | grep -v backup-metrics)" ] && ok "no .partial file left behind" || bad "partial file left"
grep -q '^safry_backup_last_run_ok 0$' "$d/backup-metrics.prom" && ok "metrics record the failed run" || bad "metrics missing failure"

# 4. Metrics after success.
d="$tmp/metrics"; mkdir -p "$d"
run "$d" DUMP_KB=10 >/dev/null
m="$d/backup-metrics.prom"
grep -q '^safry_backup_last_run_ok 1$' "$m" && ok "metrics: last_run_ok 1" || bad "metrics last_run_ok"
now="$(date +%s)"; ts="$(sed -n 's/^safry_backup_last_success_timestamp_seconds //p' "$m")"
[ -n "$ts" ] && [ "$(( now - ts ))" -lt 120 ] && ok "metrics: last success is now" || bad "metrics last success $ts"
grep -q '^safry_backup_cap_bytes 5368709120$' "$m" && ok "metrics: default cap 5120 MB" || bad "metrics cap"

# 5. Age limit still applies, and the cap can be switched off.
d="$tmp/age"; mkdir -p "$d"
old "$d" 20250101T000000Z 10 30; old "$d" 20260101T000000Z 10 2
run "$d" BACKUP_KEEP_DAYS=14 BACKUP_MAX_TOTAL_MB=0 DUMP_KB=10 >/dev/null
[ ! -e "$d/safry-20250101T000000Z.dump" ] && [ -e "$d/safry-20260101T000000Z.dump" ] && ok "BACKUP_KEEP_DAYS removes the 30-day-old dump only" || bad "age pruning wrong"
grep -q '^safry_backup_cap_bytes 0$' "$d/backup-metrics.prom" && ok "BACKUP_MAX_TOTAL_MB=0 disables the cap" || bad "cap not disabled"

# 6. Bad settings are refused.
out="$(run "$tmp/cap" BACKUP_MAX_TOTAL_MB=5)"; code=$?
[ "$code" != 0 ] && printf '%s' "$out" | grep -q "BACKUP_MAX_TOTAL_MB must be from" && ok "cap below 100 MB refused" || bad "bad cap accepted: $out"
out="$(run "$tmp/cap" BACKUP_KEEP_DAYS=abc)"; code=$?
[ "$code" != 0 ] && printf '%s' "$out" | grep -q "must be an integer" && ok "non-numeric keep days refused" || bad "bad keep accepted: $out"

[ "$failures" = 0 ] && echo "all backup cap cases behave" || { echo "$failures case(s) failed"; exit 1; }
