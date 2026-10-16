#!/usr/bin/env bash
# FIRE TEST (local only): proves the alert rules really go "firing" against a real API and that Alertmanager receives them.
#   bash scripts/alerts-fire-test.sh
# Starts Postgres + API + Prometheus + Alertmanager + a file-writing webhook sink (deploy/alerts/compose.dev.yml), sends a burst of
# failed sign-ins for a throwaway user, stops the database, then stops the API, and shows the alert states from the Prometheus
# and Alertmanager APIs. Then removes every container, volume, image and file it created.
# Needs: docker (compose v2), curl, node, openssl. Host ports used: 127.0.0.1:14010 (API), 19090 (Prometheus), 19093 (Alertmanager).
# What it does NOT prove: the `for:` durations (they are shortened to 15 s here; promtool tests cover the real ones) and any
# real notification channel (the receiver is a log file).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
alerts="$repo/deploy/alerts"
work="$alerts/.tmp-fire"
export MSYS_NO_PATHCONV=1

API=http://127.0.0.1:14010/api/v1
PROM=http://127.0.0.1:19090
AM=http://127.0.0.1:19093

secret() { head -c 48 /dev/urandom | base64 | tr -d '\n=+/' | head -c 48; }
export ALERTS_PG_PASSWORD="pg$(secret)"
export ALERTS_JWT_SECRET="$(secret)$(secret)"
export ALERTS_MFA_KEY="$(secret)$(secret)"
export ALERTS_METRICS_TOKEN="$(secret)"
export ALERTS_USER_EMAIL="firetest-$(secret | head -c 8 | tr 'A-Z' 'a-z')@example.test"
export ALERTS_USER_PASSWORD="Aa1-$(secret | head -c 20)"
export ALERTS_WORK_DIR="./.tmp-fire"

compose() { (cd "$alerts" && docker compose -f compose.dev.yml "$@"); }

cleanup() {
  status=$?
  if [ "${KEEP_STACK:-0}" = "1" ]; then echo "KEEP_STACK=1: leaving the stack running (remove with: docker compose -f deploy/alerts/compose.dev.yml --profile ops down -v)"; exit $status; fi
  echo "== teardown"
  compose --profile ops down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  if [ "${KEEP_IMAGES:-0}" != "1" ]; then docker rmi -f safry-alerts-api:test safry-alerts-migrate:test >/dev/null 2>&1 || true; fi
  exit $status
}
trap cleanup EXIT

jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log($1)}catch(e){console.log('')}})"; }

# State of one alert in Prometheus: "firing", "pending" or "none".
prom_state() {
  curl -fsS "$PROM/api/v1/alerts" | jget "(j.data.alerts.filter(a=>a.labels.alertname==='$1').map(a=>a.state)[0])||'none'"
}
wait_state() { # alertname state timeout_s
  local end=$((SECONDS + $3))
  while [ $SECONDS -lt $end ]; do
    [ "$(prom_state "$1")" = "$2" ] && return 0
    sleep 2
  done
  echo "TIMEOUT: $1 never became $2" >&2
  return 1
}

echo "== prepare (secrets are random per run and never printed)"
rm -rf "$work"; mkdir -p "$work/rules" "$work/secrets" "$work/out"
chmod 777 "$work/out"
printf '%s' "$ALERTS_METRICS_TOKEN" > "$work/secrets/metrics-token"; chmod 644 "$work/secrets/metrics-token"
: > "$work/out/alerts.log"; chmod 666 "$work/out/alerts.log"
# Same rules, only every "for: Nm" shortened to 15s so the test runs in minutes, not an hour.
sed -E 's/^([[:space:]]+for:) [0-9]+m/\1 15s/' "$alerts/safry.rules.yml" > "$work/rules/safry.rules.yml"
echo "rules copied with for: 15s ($(grep -c 'for: 15s' "$work/rules/safry.rules.yml") alerts shortened)"

echo "== images"
for pair in "runtime safry-alerts-api:test" "migrate safry-alerts-migrate:test"; do
  set -- $pair
  docker image inspect "$2" >/dev/null 2>&1 || docker build -q --target "$1" -t "$2" "$repo/backend" >/dev/null
done

echo "== start database, migrate, seed a throwaway user"
compose up -d postgres >/dev/null 2>&1
compose --profile ops run --rm migrate >/dev/null 2>&1
compose --profile ops run --rm seed >/dev/null 2>&1
echo "== start API, Alertmanager, webhook sink, Prometheus"
compose up -d api webhook-sink alertmanager prometheus >/dev/null 2>&1

end=$((SECONDS + 120))
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/health/ready" || true)" = "200" ]; do
  [ $SECONDS -lt $end ] || { echo "API never became ready"; compose logs api | tail -30; exit 1; }
  sleep 2
done
echo "API ready. Waiting for Prometheus to scrape it..."
end=$((SECONDS + 60))
until [ "$(curl -fsS "$PROM/api/v1/query?query=up%7Bjob%3D%22safry-api%22%7D" 2>/dev/null | jget "j.data.result[0]&&j.data.result[0].value[1]")" = "1" ]; do
  [ $SECONDS -lt $end ] || { echo "Prometheus never saw the API as up"; exit 1; }
  sleep 2
done
echo "BASELINE alerts in Prometheus: LoginFailureSpike=$(prom_state LoginFailureSpike) DatabaseUnreachable=$(prom_state DatabaseUnreachable) ApiDown=$(prom_state ApiDown)"

echo "== 1. burst of failed sign-ins"
login() { curl -s -o /dev/null -w '%{http_code}' -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$1\",\"password\":\"Wrong-Password-1!\",\"tenantCode\":\"alertsdemo\"}"; }
codes=""
for i in $(seq 1 12); do codes="$codes $(login "$ALERTS_USER_EMAIL")"; done            # throwaway user: wrong password, then locked
for i in $(seq 1 45); do codes="$codes $(login "nobody-$i@example.test")"; done          # unknown accounts (password guessing across names)
echo "answer codes (all 401 expected, no 429): $(echo $codes | tr ' ' '\n' | sort | uniq -c | tr '\n' ';')"
failures="$(curl -fsS -H "Authorization: Bearer $ALERTS_METRICS_TOKEN" "$API/metrics" | grep -E '^safry_(login_failures_total|account_lockouts_total)' | tr '\n' ';')"
echo "API counters: $failures"
wait_state LoginFailureSpike firing 90
echo "Prometheus: LoginFailureSpike=$(prom_state LoginFailureSpike) LockoutSpike=$(prom_state LockoutSpike)"

echo "== 2. stop the database"
docker stop safry-alerts-postgres >/dev/null
# The compose health check probes /health/ready every 3 s, like an orchestrator; this loop only confirms the answer.
echo "readiness answer with the database down: HTTP $(curl -s -o /dev/null -w '%{http_code}' "$API/health/ready")"
wait_state DatabaseUnreachable firing 90
echo "Prometheus: DatabaseUnreachable=$(prom_state DatabaseUnreachable) ReadinessDown=$(prom_state ReadinessDown)"

echo "== 3. stop the API"
docker stop safry-alerts-api >/dev/null
wait_state ApiDown firing 90
echo "Prometheus: ApiDown=$(prom_state ApiDown)"

echo "== evidence"
echo "-- Prometheus /api/v1/alerts (alert, state, activeAt)"
curl -fsS "$PROM/api/v1/alerts" | jget "j.data.alerts.map(a=>a.labels.alertname+'  '+a.state+'  '+a.activeAt).join('\n')"
sleep 8 # let Alertmanager group_wait / group_interval pass
echo "-- Alertmanager /api/v2/alerts (alert, state, severity, startsAt)"
curl -fsS "$AM/api/v2/alerts" | jget "j.map(a=>a.labels.alertname+'  '+a.status.state+(a.status.inhibitedBy.length?' (inhibited)':'')+'  '+a.labels.severity+'  '+a.startsAt).join('\n')"
echo "-- webhook sink log (what a receiver got)"
cat "$work/out/alerts.log"

fail=0
for name in LoginFailureSpike DatabaseUnreachable ApiDown; do
  grep -q " firing $name " "$work/out/alerts.log" || { echo "FAIL: receiver never got $name"; fail=1; }
done
grep -q " firing ReadinessDown " "$work/out/alerts.log" && { echo "NOTE: ReadinessDown reached the receiver (expected to be inhibited by DatabaseUnreachable)"; }
[ "$fail" = 0 ] && echo "FIRE TEST PASSED" || { echo "FIRE TEST FAILED"; exit 1; }
