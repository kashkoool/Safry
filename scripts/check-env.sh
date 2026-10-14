#!/bin/sh
# Checks a compose .env file before deployment: every variable docker-compose.yml requires is
# present, secrets are not placeholders/short/reused, DB passwords are URL-safe, and the HTTP
# settings are production-safe. Prints only variable NAMES, never values.
#   scripts/check-env.sh [.env] [docker-compose.yml]
# Exit 0 = OK, 1 = problems found.
set -uf  # -f: no globbing, a "*" value must stay literal
envfile="${1:-.env}"
composefile="${2:-$(dirname "$0")/../docker-compose.yml}"
[ -f "$envfile" ] || { echo "error: $envfile not found" >&2; exit 1; }
[ -f "$composefile" ] || { echo "error: $composefile not found" >&2; exit 1; }

fail=0
problem() { echo "FAIL $1: $2"; fail=1; }

# Last assignment wins, like docker compose. Strips CR (files edited on Windows) and surrounding quotes.
get() {
  sed -n "s/^[[:space:]]*$1=//p" "$envfile" | tail -n 1 | tr -d '\r' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
is_set() { grep -Eq "^[[:space:]]*$1=" "$envfile"; }
placeholder() { printf '%s' "$1" | grep -Eiq 'change_me|change-me|changeme|replace-with|replace_with|replace-before|placeholder|your-secret|example'; }

# 1. Completeness: every ${VAR:?...} in the compose file (profiles tls/seed excluded below).
for var in $(grep -o '\${[A-Z0-9_]*:?' "$composefile" | sed 's/^\${//; s/:?$//' | sort -u); do
  [ "$var" = "SITE_ADDRESS" ] && continue
  [ -n "$(get "$var")" ] || problem "$var" "required by docker-compose.yml but missing or empty"
done

# 2. Secrets.
secret() { # name min_length url_safe(0/1)
  v="$(get "$1")"
  [ -n "$v" ] || return 0
  placeholder "$v" && problem "$1" "is still a placeholder"
  [ "${#v}" -ge "$2" ] || problem "$1" "shorter than $2 characters"
  [ "$(printf '%s' "$v" | fold -w1 | sort -u | wc -l)" -ge 10 ] || problem "$1" "too few distinct characters (not random)"
  if [ "$3" = 1 ] && printf '%s' "$v" | grep -q '[^A-Za-z0-9._~-]'; then
    problem "$1" "contains characters that break a postgresql:// URL; use: openssl rand -hex 32"
  fi
}
secret POSTGRES_PASSWORD 24 1
secret DATABASE_RUNTIME_PASSWORD 24 1
secret JWT_ACCESS_SECRET 32 0
secret MFA_ENCRYPTION_KEY 32 0
secret RESEND_API_KEY 16 0
mail_from="$(get MAIL_FROM)"
if [ -n "$mail_from" ]; then
  placeholder "$mail_from" && problem MAIL_FROM "is still a placeholder"
  printf '%s' "$mail_from" | grep -Eq '^([^<>]+ <[^<> @]+@[^<> @]+\.[^<> @]+>|[^<> @]+@[^<> @]+\.[^<> @]+)$' || problem MAIL_FROM "must be an address or Name <address>"
fi
base_url="$(get APP_BASE_URL)"
if [ -n "$base_url" ]; then
  placeholder "$base_url" && problem APP_BASE_URL "is still a placeholder"
  printf '%s' "$base_url" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' || problem APP_BASE_URL "must be a bare https origin (no path, no trailing slash)"
fi
[ -n "$(get JWT_ACCESS_SECRET)" ] && [ "$(get JWT_ACCESS_SECRET)" = "$(get MFA_ENCRYPTION_KEY)" ] && problem MFA_ENCRYPTION_KEY "must differ from JWT_ACCESS_SECRET"
[ -n "$(get POSTGRES_PASSWORD)" ] && [ "$(get POSTGRES_PASSWORD)" = "$(get DATABASE_RUNTIME_PASSWORD)" ] && problem DATABASE_RUNTIME_PASSWORD "must differ from POSTGRES_PASSWORD"

# 3. HTTP settings.
cors="$(get CORS_ORIGINS)"
if [ -n "$cors" ]; then
  for origin in $(printf '%s' "$cors" | tr ',' ' '); do
    printf '%s' "$origin" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' || problem CORS_ORIGINS "entry is not a bare https origin (no *, http, path or trailing slash)"
  done
fi
tp="$(get TRUST_PROXY)"
case "${tp:-1}" in
  false|true|[0-9]|10) ;;
  *) for entry in $(printf '%s' "$tp" | tr ',' ' '); do
       printf '%s' "$entry" | grep -Eq '^(loopback|linklocal|uniquelocal|[0-9A-Fa-f:.]+(/[0-9]{1,3})?)$' || problem TRUST_PROXY "must be true, false, a hop count or a list of proxy IPs/CIDRs"
     done ;;
esac
[ "$(get SWAGGER_ENABLED)" = "true" ] && problem SWAGGER_ENABLED "API docs must stay off in production"
[ "$(get ALLOW_DEMO_SEED_IN_PRODUCTION)" = "true" ] && problem ALLOW_DEMO_SEED_IN_PRODUCTION "demo seed must not be enabled for a real deployment"
if is_set SITE_ADDRESS && [ -n "$(get SITE_ADDRESS)" ] && [ "${tp:-1}" = "1" ]; then
  problem TRUST_PROXY "SITE_ADDRESS is set (tls profile): the API sits behind 2 proxies, set TRUST_PROXY=2"
fi
case "$(get WEB_BIND)" in
  ""|127.0.0.1|::1) ;;
  *)
    # With 2 or more trusted hops the API believes the next-to-last X-Forwarded-For entry. If clients can reach the web
    # container directly (non-loopback publish) they supply that entry themselves and choose request.ip, which keys the
    # rate limits and the account lockout. Deliberate topologies (a load balancer on another host with the
    # port firewalled to it) acknowledge it explicitly.
    case "${tp:-1}" in
      false|0|1|true) echo "WARN WEB_BIND: web is published on a non-loopback interface; make sure TLS terminates in front of it" ;;
      *)
        if [ "$(get ALLOW_PUBLIC_WEB_BIND_WITH_PROXY_HOPS)" = "true" ]; then
          echo "WARN WEB_BIND: non-loopback publish with TRUST_PROXY=$tp acknowledged; the port MUST be reachable only from your proxy/load balancer"
        else
          problem WEB_BIND "TRUST_PROXY=$tp trusts forwarded client addresses, but the web port is published on a non-loopback interface, so clients can forge request.ip (rate-limit and lockout key). Keep WEB_BIND=127.0.0.1, or set ALLOW_PUBLIC_WEB_BIND_WITH_PROXY_HOPS=true if a firewall limits the port to your proxy"
        fi ;;
    esac ;;
esac

[ "$fail" = 0 ] && echo "OK: $envfile passes all checks"
exit "$fail"
