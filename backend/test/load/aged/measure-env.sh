#!/usr/bin/env bash
# Starts the API for measurement runs. Usage: bash measure-env.sh <a|b> <safry|safry_fresh> [limits-raised|defaults]
# limits-raised (sweep, growth, soak): the per-address, per-user and refresh rate limits are lifted so the load generator is not throttled
#   (the hard-coded per-route limits on login, register, ... stay on; every call carries its own X-Forwarded-For address) and the pending
#   bookings per traveler cap is 1000. defaults (probes): the shipped limits.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="${1:?a|b}"
DB="${2:-safry}"
MODE="${3:-limits-raised}"
if [ "$MODE" = "limits-raised" ]; then
  export API_EXTRA_ENV="RATE_LIMIT_IP_PER_MINUTE=1000000 RATE_LIMIT_USER_PER_MINUTE=1000000 RATE_LIMIT_ACCOUNT_PER_MINUTE=1000000 RATE_LIMIT_REFRESH_SESSION_PER_MINUTE=1000000 RATE_LIMIT_REFRESH_INVALID_PER_MINUTE=1000000 BOOKING_MAX_PENDING_PER_TRAVELER=1000 MAIL_BUDGET_REGISTRATION_PER_HOUR=100000 MAIL_BUDGET_REGISTRATION_PER_DAY=100000 MAIL_BUDGET_RESET_PER_HOUR=100000 MAIL_BUDGET_RESET_PER_DAY=100000 MAIL_BUDGET_SECURITY_PER_HOUR=100000 MAIL_BUDGET_SECURITY_PER_DAY=100000 MAIL_ADDRESS_REGISTRATION_PER_DAY=100000 MAIL_ADDRESS_RESET_PER_DAY=100000 MAIL_RECIPIENT_RESET_PER_DAY=1000"
else
  export API_EXTRA_ENV="${API_EXTRA_ENV:-}"
fi
bash "$HERE/infra.sh" "$RUN" api "$DB"
