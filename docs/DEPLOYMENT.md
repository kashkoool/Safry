# Deployment runbook (Docker Compose, provider-neutral)

> Target production architecture (Azure UAE North + Cloudflare, not yet provisioned): see [INFRASTRUCTURE.md](INFRASTRUCTURE.md).

This runbook deploys the Safry stack on any Linux host with Docker Engine 24+ and Compose v2.
Hosting provider, region (Qatar, KSA or Frankfurt) and the TLS terminator are **still to be decided**;
nothing here depends on a specific provider. Database operations (roles, backups, PITR, restore drills)
are detailed in `backend/docs/database-operations.md`.

## 1. What runs

| Service | Image | Runs as | Network | Published | Lifecycle |
|---|---|---|---|---|---|
| `postgres` | `postgres:17.11-alpine` (digest-pinned) | postgres (entrypoint drops root) | `data` (internal, no Internet) | never | long-running |
| `api` | `backend/Dockerfile` target `runtime` (Alpine, production deps only) | `node` (uid 1000) | `data` + `app` | never | long-running |
| `web` | `frontend/Dockerfile` (nginx-unprivileged 1.30) | uid 101 | `app` | `WEB_BIND:WEB_PORT` (loopback by default) | long-running |
| `migrate` | target `migrate` | `node` | `data` | no | one-off (`run --rm`) |
| `db-roles` | `postgres:17.11-alpine` + `backend/scripts/db/create-runtime-role.sql` | postgres | `data` | no | one-off |
| `seed` | target `migrate` | `node` | `data` | no | one-off, demo only, profile `seed` |
| `proxy` | `caddy:2.11.7-alpine` | root without capabilities except NET_BIND_SERVICE | `app` | 80, 443 (tcp+udp) | optional, profile `tls` |
| `backup` | `postgres:17.11-alpine` + `backend/scripts/backup/backup.sh` | postgres | `data` | no | optional, profile `backup` |

Every service: read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, memory/CPU/PID limits,
log rotation (10 MB x 5). Nothing migrates or seeds when a container starts or restarts.

Two database logins (see `backend/docs/database-operations.md` section 1):

- `safry` (`POSTGRES_PASSWORD`): owner/superuser of the container database. Used only by `migrate`,
  `db-roles`, `seed` and `backup`.
- `safry_runtime` (`DATABASE_RUNTIME_PASSWORD`): `NOSUPERUSER NOBYPASSRLS`, member of `safry_app`. The only
  login the API has.

## 2. First deployment

```sh
cp docker.env.example .env          # then replace every CHANGE_ME value (generators are in the file)
chmod 600 .env
scripts/check-env.sh .env           # must print OK; it never prints values

docker compose build                # api + web (add --profile ops for the migrate image)
docker compose --profile ops build migrate
docker compose up -d --wait postgres
docker compose run --rm migrate     # prisma migrate deploy with the owner login
docker compose run --rm db-roles    # creates safry_runtime with DATABASE_RUNTIME_PASSWORD
docker compose up -d --wait         # api + web
```

A fresh database has no tenant or administrator yet. `backend/prisma/bootstrap.ts` (`pnpm db:bootstrap`)
creates the first tenant and administrator without any demo data and is safe in production. There is no
dedicated compose service for it; run it through the `migrate` image (same owner login, one-off), after
`migrate` and `db-roles` have run:

```sh
docker compose --profile ops run --rm   -e BOOTSTRAP_ADMIN_EMAIL=admin@example.com -e BOOTSTRAP_ADMIN_PASSWORD='<>=12 chars, not a placeholder>'   -e BOOTSTRAP_TENANT_CODE=safry -e BOOTSTRAP_TENANT_NAME='Safry Platform'   migrate node node_modules/tsx/dist/cli.mjs prisma/bootstrap.ts
```

Existing accounts are never modified. Do not use the demo seed on a real deployment.

Local demo only (creates known demo accounts):

```sh
docker compose run --rm -e ALLOW_DEMO_SEED_IN_PRODUCTION=true \
  -e BOOTSTRAP_ADMIN_PASSWORD=... -e DEMO_SEED_PASSWORD=... seed
```

## 3. Rolling out a new version

1. Take a backup (`docker compose run --rm --entrypoint sh backup /scripts/backup.sh`, or the
   managed database snapshot).
2. `docker compose build` (or pull the tagged images: set `IMAGE_PREFIX` / `IMAGE_TAG`).
3. `docker compose run --rm migrate` when the release contains migrations. A failed migration stops here;
   the running API is untouched.
4. `docker compose up -d --wait`.
5. Verify the new revision is the one serving, not only that something answers:
   - `docker compose ps` shows the new image IDs and `healthy`;
   - `docker compose logs --since 5m api` has `Nest application successfully started` and no errors;
   - `curl -fsS https://<host>/api/v1/health/ready` returns `{"status":"ok","database":"reachable","rateLimit":"ok"}` (`status` is `degraded` and `rateLimit` `degraded-in-process` while the shared rate-limit store is unavailable; 503 when the database is unreachable or the API is draining);
   - exercise one changed path (for example log in).

Rollback: redeploy the previous image tag. Migrations are forward-only; a migration that is not
backward-compatible needs a restore (section 6).

Rotate the runtime password: change `DATABASE_RUNTIME_PASSWORD`, run `db-roles` again, then
`docker compose up -d api`.

### Health checks: intentional split

The API image's `HEALTHCHECK` is **liveness** (`/health/live`, no database call), so a slow database never gets a healthy container
killed by an orchestrator. The compose `api` healthcheck is **readiness** (`/health/ready`, database reachable), because in compose
it only gates the `web` container (`depends_on: service_healthy`) and nothing restarts on unhealthy. Other orchestrators should use
live for restarts and ready for traffic routing.

### Running the Playwright suite against the compose stack (dev/test only)

Never in production. The suite needs the demo accounts, which the opt-in `seed` profile creates and which refuses to run unless
explicitly overridden. On a throwaway stack (own `.env`, own volumes, never a real database):

```
docker compose run --rm -e ALLOW_DEMO_SEED_IN_PRODUCTION=true -e DEMO_SEED_PASSWORD=<generated>   -e BOOTSTRAP_ADMIN_PASSWORD=<generated> seed
cd frontend && E2E_NO_SERVER=1 E2E_BASE_URL=http://127.0.0.1:<WEB_PORT> E2E_API_URL=http://127.0.0.1:<WEB_PORT>   E2E_DEMO_PASSWORD=<same DEMO_SEED_PASSWORD> E2E_ADMIN_PASSWORD=<same BOOTSTRAP_ADMIN_PASSWORD> pnpm e2e
```

Tear the stack down with `docker compose down -v` afterwards. See `frontend/README.md` for the full variable list.

## 4. TLS and proxy topology

The web container speaks plain HTTP on 8080 and is published on `127.0.0.1` by default. Put exactly one
TLS terminator in front of it:

| Option | How | `TRUST_PROXY` |
|---|---|---|
| Bundled Caddy (automatic certificates) | DNS A/AAAA record to the host, ports 80/443 open, `SITE_ADDRESS=<host name>` in `.env`, `docker compose --profile tls up -d` | `2` |
| Managed load balancer / CDN of the chosen provider | Forward to `WEB_BIND:WEB_PORT` (set `WEB_BIND` to the private interface), terminate TLS there, forward `X-Forwarded-For` and `X-Forwarded-Proto` | `2` (or the exact proxy CIDRs) |
| Cloudflare proxy + Origin Certificate (recommended for public sites; see 4.1) | `CADDYFILE=./deploy/caddy/Caddyfile.cloudflare`, certificate in `CADDY_CERT_DIR`, `docker compose --profile tls up -d` | `2` |
| Nothing (local machine only) | Browse `http://127.0.0.1:<WEB_PORT>` | `1` |

`TRUST_PROXY` is the number of proxies in front of the API (nginx counts as one). Too low and every user
shares the proxy's IP in rate limits; too high and clients can spoof their IP with `X-Forwarded-For`.
Also accepted: a comma-separated list of proxy IPs/CIDRs. HSTS is sent by nginx only when the terminator
reports `X-Forwarded-Proto: https`. Caddy redirects HTTP to HTTPS.

### 4.1 Cloudflare proxy with an Origin Certificate (SSL mode Full (strict))

Chain: visitor -> Cloudflare edge (TLS 1) -> Caddy on your host (TLS 2, Origin Certificate) -> nginx (`web`) -> API.

1. Cloudflare dashboard: add the DNS record as **proxied**, SSL/TLS mode **Full (strict)**, enable "Always use HTTPS" and HSTS (or keep the HSTS header from nginx, which passes through).
2. SSL/TLS > Origin Server > Create Certificate for the host name; save the certificate as `origin.pem` and the key as `origin.key` in a directory outside the repository (`CADDY_CERT_DIR`, default `deploy/caddy/certs/`, git-ignored). Never commit them.
3. `.env`: `SITE_ADDRESS=<host name>`, `CADDYFILE=./deploy/caddy/Caddyfile.cloudflare`, `TRUST_PROXY=2`, `WEB_BIND=127.0.0.1`. Then `docker compose --profile tls up -d`.
4. Firewall: allow inbound 80/443 **only from Cloudflare's published ranges** (https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6). Fetch them when you write the rules and refresh on a schedule (for example a weekly job that rebuilds the firewall set from those two URLs); do not paste a list into this repository. Everything else on the host stays closed.

**Real client address.** The API does not read `CF-Connecting-IP`. It uses Express `request.ip` with `TRUST_PROXY` (`backend/src/app.setup.ts`), and the rate limiter and login lockout key on that address (`backend/src/app.module.ts`, `common/http/rate-limit.ts`). `Caddyfile.cloudflare` therefore sets `X-Forwarded-For` to the `CF-Connecting-IP` value; nginx appends Caddy's address; with `TRUST_PROXY=2` the API skips those two hops and takes the visitor address. Consequences:

- `TRUST_PROXY=1` (the default) behind Cloudflare makes every visitor share Caddy's address: one rate-limit bucket for all users. `3` or more trusts a client-supplied entry.
- This is only safe while nothing but Cloudflare can reach ports 80/443 (step 4). A direct caller could otherwise send its own `CF-Connecting-IP` and rotate rate-limit keys at will.
- Using Cloudflare without Caddy (Flexible or an own TLS terminator) is not covered here: Flexible mode sends plain HTTP over the internet and is not acceptable for this application.
- Proven vs not: with `caddy:2-alpine`, `caddy adapt` of `Caddyfile.cloudflare` produces a request-header `set` of `X-Forwarded-For` (replace, not append). In a throwaway Caddy with the same `header_up` line in front of an echo site, a request with `CF-Connecting-IP: 203.0.113.9` and a forged `X-Forwarded-For: 6.6.6.6` reached the backend as exactly `203.0.113.9`; with no `CF-Connecting-IP` the header arrived empty (the client-supplied value is dropped, not passed on); two `CF-Connecting-IP` headers were joined as `a,b` (only Cloudflare-fronted traffic is safe, see above). Not run here: the real nginx hop, the TLS certificate files, Cloudflare itself (`caddy validate` of the real file fails only on the missing certificate files).
- Check after deployment: log in with a wrong password and confirm the throttle/audit address is your own, not a Cloudflare address.

**HSTS and cookies.** nginx sends `Strict-Transport-Security` (1 year, includeSubDomains) when `X-Forwarded-Proto` is `https`; Caddy forwards that header. Add the host to the HSTS preload list only after confirming every subdomain serves HTTPS. The API issues one cookie, the HttpOnly refresh cookie (see "Sign-in cookie" below): it is `Secure` (named `__Secure-safry_rt`) in production, so the site must be served over HTTPS. Any further cookie must also be `Secure`, `HttpOnly` and `SameSite`.

**Data residency.** Cloudflare terminates TLS at its edge and decrypts traffic there, possibly in a data centre outside the country of your users, even when your origin and database are local. For personal data under KSA PDPL or Qatar PDPPL, get legal advice on cross-border processing before choosing this option; Cloudflare's regional services and data localisation products can narrow where traffic is decrypted. The bundled Caddy automatic-certificate option above has no third-party edge and is the alternative when that is unacceptable.

Security headers on every response from the web origin (nginx): CSP (same-origin only,
`frame-ancestors 'none'`), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy`, COOP, CORP, HSTS over HTTPS. Check after deployment:

```sh
curl -sI https://<host>/ | grep -iE 'content-security|strict-transport|x-frame|x-content|referrer|permissions'
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/api/v1/docs   # 404: API docs are off in production
```

### Sign-in cookie (browser sessions)

On the web the refresh token is an HttpOnly cookie, never in a response body or in web storage; the 15-minute access token lives in page memory only.

| Property | Value |
|---|---|
| Name | `__Secure-safry_rt` in production, `safry_rt` otherwise |
| Flags | `HttpOnly; SameSite=Strict; Secure` (Secure only when `NODE_ENV=production`), no `Domain` (host-only) |
| Path | `/api/v1/auth` (not `__Host-`: that prefix needs `Path=/`, which would send the cookie to every API route) |
| Lifetime | `Max-Age` = remaining absolute session lifetime (`SESSION_ABSOLUTE_TIMEOUT_HOURS`, default 24 h); idle timeout 15 min is enforced server-side |
| CSRF | `/auth/refresh` and `/auth/logout` need `X-Requested-With: XMLHttpRequest`; a present `Origin` must be a `CORS_ORIGINS` entry (whole string: scheme, host, port) or the request's own origin: scheme, `Host` and port (403 otherwise). The scheme comes from `X-Forwarded-Proto` only when `TRUST_PROXY` is set |

Operational consequences:
- Serve the site over HTTPS (the `tls` profile, or your load balancer). A `Secure` cookie is dropped by browsers on plain `http://` except `localhost`/`127.0.0.1`, so on a bare-HTTP LAN address the sign-in succeeds but the session cannot resume.
- The web container's nginx forwards `Host` with its port (`$http_host`); keep that when you replace the proxy, otherwise same-origin requests fail the Origin check unless the exact origin is listed in `CORS_ORIGINS`.
- The proxy chain must pass `X-Forwarded-Proto` and `TRUST_PROXY` must count it: with TRUST_PROXY unset behind a TLS terminator the API sees `http`, so an `https://` same-origin Origin is refused (403) unless listed in `CORS_ORIGINS`. The bundled nginx and Caddy forward it.
- Two cookies with the refresh-cookie name in one request (for example one planted by a sibling subdomain) make `/auth/refresh` answer 401 and change nothing; the user must clear site cookies. Keep untrusted sibling subdomains off the parent domain.
- Native apps (React Native later) send `X-Client: mobile` and get the refresh token in the JSON body (no cookie).

## 5. Configuration reference (compose `.env`)

| Variable | Required | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | owner login; URL-safe (`openssl rand -hex 32`) |
| `DATABASE_RUNTIME_PASSWORD` | yes | API login; URL-safe, different from the owner password |
| `JWT_ACCESS_SECRET` | yes | 32+ random characters; placeholders rejected at boot |
| `MFA_ENCRYPTION_KEY` | yes | different from `JWT_ACCESS_SECRET` |
| `WEB_BIND`, `WEB_PORT` | no | default `127.0.0.1:3001` |
| `TRUST_PROXY` | no | default `1`; see section 4 |
| `CORS_ORIGINS` | no | empty = same-origin only; otherwise exact `https://` origins (credentials are allowed for exactly these); `*` is rejected |
| `SWAGGER_ENABLED` | no | default `false` in production |
| `RESEND_API_KEY`, `MAIL_FROM`, `APP_BASE_URL` | yes | transactional e-mail, see section 5a; `MAIL_TRANSPORT` is fixed to `resend` by compose |
| `SITE_ADDRESS`, `HTTP_PORT`, `HTTPS_PORT`, `HTTP_BIND` | tls profile | public host name and published ports |
| `BACKUP_INTERVAL_SECONDS`, `BACKUP_KEEP_DAYS` | backup profile | default daily, keep 14 days |
| `SESSION_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS` | maintenance profile | daily maintenance job (`backend/scripts/db/purge.sh`): creates audit partitions ahead, purges sessions 30 days after expiry (default), drops `audit_events` partitions older than 24 months (default; `AUDIT_RETENTION_DAYS` overrides, min 30) |
| `API_MEM_LIMIT`, `API_CPUS`, `POSTGRES_MEM_LIMIT`, `POSTGRES_CPUS` | no | resource limits |
| `IMAGE_PREFIX`, `IMAGE_TAG` | no | image names `<prefix>-api:<tag>` etc. Default prefix `safry`: two checkouts on one host share image names, so set a distinct `IMAGE_PREFIX` (and `COMPOSE_PROJECT_NAME`) in each `.env`. |

Secrets are injected at runtime from `.env` (or the host's secret manager exporting the same variables);
none are baked into images (`.env*` is in both `.dockerignore` files). `scripts/check-env.sh` checks
completeness against `docker-compose.yml` and rejects placeholders, short/low-variety secrets, reused
secrets, URL-unsafe database passwords, wildcard/`http` CORS origins and enabled Swagger.

## 5a. Transactional email (Resend)

Password reset, e-mail confirmation and the "your password was changed" notice are sent through [Resend](https://resend.com)
over its HTTPS API (no SDK; the API image calls `https://api.resend.com/emails` with a bounded timeout). The behaviour of the
flows (endpoints, tokens, verification rule) is in `backend/docs/auth-email-flows.md`.

Settings (API container; compose already wires them, `scripts/check-env.sh` checks them):

| Variable | Notes |
|---|---|
| `MAIL_TRANSPORT` | `resend` (compose sets it) or `console`. Production refuses `console` and refuses to start without a real key |
| `RESEND_API_KEY` | secret, never defaulted, required when the transport is `resend`; placeholders rejected at boot |
| `MAIL_FROM` | sender on the verified domain: `Safry <no-reply@mail.your-domain.tld>` |
| `APP_BASE_URL` | public `https` origin of the web app, no path; links look like `${APP_BASE_URL}/reset-password#token=...` |
| `MAIL_TIMEOUT_MS`, `AUTH_MAIL_MIN_RESPONSE_MS` | optional: provider timeout (default 8000), fixed minimum answer time of the "send me a link" endpoints (default 300) |
| `MAIL_RETRY_ATTEMPTS`, `MAIL_RETRY_BASE_MS` | optional: total tries for transient mail failures (1-5, default 3) and base wait (default 2000 ms, then x5) |

### One-time setup

1. Create a Resend account and open **Domains > Add domain**. Use a sending subdomain such as `mail.your-domain.tld`, so the
   records never touch the mailboxes of the root domain.
2. Resend shows the DNS records to add. In Cloudflare (**DNS > Records**) create each exactly as shown, with the proxy **off
   (grey cloud, "DNS only")**: mail records cannot be proxied. Typical set:
   - **SPF**: a `TXT` record (and the `MX` Resend lists) on the `send.` subdomain Resend names, value `v=spf1 include:amazonses.com ~all`
     (Resend sends through Amazon SES; copy what the dashboard shows, it is authoritative).
   - **DKIM**: a `TXT` record `resend._domainkey.<your sending domain>` with the long `p=...` public key from the dashboard.
   - **DMARC**: a `TXT` record `_dmarc.<your domain>`. Start with `v=DMARC1; p=none; rua=mailto:dmarc@your-domain.tld`, read the
     aggregate reports for two to four weeks, then tighten to `p=quarantine` and later `p=reject`.
3. Click **Verify DNS records** in Resend and wait until the domain shows *Verified* (usually minutes, up to a day).
4. **API Keys > Create API key**: permission *Sending access*, restricted to that one domain. Copy the key once.
5. Put it where the API reads it: the compose `.env` on the host (`RESEND_API_KEY=...`, file mode 600, never committed), or the
   secret manager of the host. With the Azure layout in `INFRASTRUCTURE.md` it belongs in **Key Vault** with an App Service
   Key Vault reference (managed identity, "get secret" only). Never put it in git, CI variables, images or chat. Rotate it by
   creating a new key, deploying, then deleting the old one in Resend.
6. Set `MAIL_FROM` and `APP_BASE_URL`, run `scripts/check-env.sh .env`, deploy.

### Testing without a mail account

Development and tests use `MAIL_TRANSPORT=console` (the default outside production). Nothing leaves the machine: the API logs
the recipient, the subject and the link, for example `MailConsole to=user@example.test subject="Reset your Safry password" link=http://localhost:3001/reset-password#token=...`.
That log line contains a credential, which is why production refuses the transport. After setting up Resend, send yourself a
reset request from the real site and confirm it arrives in the inbox (not spam) and that the link opens the reset page.

### Deliverability checklist

- [ ] Domain shows *Verified* in Resend; SPF, DKIM and DMARC records exist and are DNS only in Cloudflare.
- [ ] Sender (`MAIL_FROM`) uses that exact domain; `no-reply@` is fine because replies are not expected.
- [ ] DMARC starts at `p=none` with a `rua` mailbox you read; tighten after the reports are clean.
- [ ] Send a test to Gmail and Outlook and open "Show original": `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.
- [ ] The messages are plain text plus simple HTML, no remote images, no tracking pixels or rewritten links (as shipped).
- [ ] Watch Resend's bounce and complaint rates; stop and investigate above about 4% bounces or 0.08% complaints.
- [ ] The API log shows no `not delivered` lines (they carry the HTTP status of the provider, never the recipient or the body).
- [ ] The API key is the restricted, single-domain kind and is stored only in the secret store.

Delivery is fire-and-forget after the HTTP answer (so provider latency cannot reveal whether an address has an account). A
provider outage therefore loses that message; the user simply asks again (the per-account limit allows one link a minute).

## 6. Backups and restore

- Preferred in production: the provider's managed PostgreSQL with automated backups and PITR, in the
  same jurisdiction as the data (open decision).
- Self-hosted: `docker compose --profile backup up -d backup` runs `backup.sh` every
  `BACKUP_INTERVAL_SECONDS` into the `safry_backups` volume and turns `unhealthy` when no dump is newer
  than two intervals (alert on it). Copy the dumps off the host (encrypted object storage in-region);
  a dump on the same disk as the database is not a backup.
- Restore into a new, empty database with `backend/scripts/backup/restore.sh`, then rehearse it on a
  schedule (`restore-test.sh`). RPO/RTO targets are still to be decided.

## 7. Local development

`backend/compose.yml` runs only PostgreSQL for development, published on `127.0.0.1:${POSTGRES_PORT:-5432}`.
The production `docker-compose.yml` never publishes the database.

## 8. Scanning

`.github/proposed/image-scan.yml` (to be activated) builds the images, writes CycloneDX SBOMs and fails on
fixable HIGH/CRITICAL findings, weekly as well as on changes. Manual run:

```sh
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.75.0 \
  image --scanners vuln --severity HIGH,CRITICAL safry-api:local
```
