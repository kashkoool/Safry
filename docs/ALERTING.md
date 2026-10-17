# Alerting

What tells a human that something is wrong. The rules are provider neutral (Prometheus format) and tested; wiring them to a real
notification channel and to Azure is a checklist at the end, not done yet.

| Piece | Where |
|---|---|
| Alert rules | `deploy/alerts/safry.rules.yml` |
| Rule tests (promtool) | `deploy/alerts/safry.rules.test.yml`, run with `bash scripts/alerts-test.sh` (Docker only) |
| Local "does it really fire" test | `bash scripts/alerts-fire-test.sh` (Docker, curl, node, openssl; about 3 minutes) |
| Metrics source | `backend/src/common/http/metrics.ts`, endpoint `GET /api/v1/metrics` |
| CI | `.github/workflows/alerts.yml` (not a required check) |

## 1. How the signals get out

The API serves Prometheus text on `/api/v1/metrics`. The endpoint answers 404 until `METRICS_TOKEN` is set. After that the `Authorization` header must carry the token, either as `Bearer <token>` or as the bare token (the handler strips an optional `Bearer ` prefix and compares in constant time); anything else, including a missing header, answers 401. Use the Bearer form in scraper configuration. Keep the token in the secret store, give it only to the scraper, and never expose the
path through the public proxy (block `/api/v1/metrics` at Cloudflare or the proxy; the scraper reaches the API on the private network).

Counters added for alerting (labels are fixed words, never an e-mail, address, user or tenant):

| Metric | Meaning |
|---|---|
| `safry_login_failures_total{reason}` | Failed credential checks: `bad_credentials` (unknown account, wrong password, unverified or inactive account), `locked` (refused by the lockout), `mfa_failed`, `portal_denied` (right password, wrong portal). Also counts failed re-checks of the password for signed-in users. |
| `safry_account_lockouts_total` | A sign-in block started on a known account. |
| `safry_refresh_reuse_detected_total` | A rotated refresh token was presented again after the grace window. |
| `safry_platform_admin_signins_total` | Completed platform-administrator sign-ins. |
| `safry_platform_admin_mfa_resets_24h` (gauge) | Break-glass MFA resets in the last 24 hours, read from the audit trail (the reset runs in a separate script, so no in-process counter could see it). Omitted while the database is down. |
| `safry_mail_delivery_total{outcome}` | Detached mails (password reset, verification) that ended `sent` or `failed`. |
| `safry_mail_budget_exhausted_total{pool}` | Mails dropped because a mail pool was spent: `registration` (verification mail for new sign-ups), `reset` (reset and resend mail for existing accounts) or `security` (owner notices). |
| `safry_mail_address_capped_total{scope}` | Sign-up (`registration`) or forgot-password / resend (`reset`) requests that sent no mail because their client address reached its daily cap. |
| `safry_process_start_time_seconds` (gauge) | Unix time the API process started; it changes on every restart, which the `ProcessRestarting` alert counts. |
| `safry_rate_limited_total{group}` | HTTP 429 answers, `auth` routes or `api` (all others). |
| `safry_readiness_failures_total{reason}` | Readiness probes answered 503: `database` or `draining`. |

Already present: `safry_http_requests_total`, `safry_http_request_duration_ms_*` (per route template and status class),
`safry_rate_limit_degraded`, `safry_auth_cache_*`, memory gauges.

## 2. Alerts: what they mean and the first action

Severity `page` = wake someone; `ticket` = look in working hours. Who is notified is a placeholder until the deployment exists:
**page -> on-call phone (TBD), ticket -> team inbox or chat channel (TBD)**.

### ProcessRestarting
*page.* The API process started more than 2 times in 15 minutes: a crash loop. The process handlers exit on an unhandled rejection or uncaught exception and the platform restarts the process. It counts restarts of scrape targets with a stable address; if every restart gets a new target name (for example a new pod name), it cannot see them, so also alert on the platform's own restart count. First action: read the log just before each restart (error class and message length only), check the last deploy and roll it back if the loop started with it, then find the request that triggers the crash.

### ApiDown
*page.* Prometheus cannot read `/metrics` for 2 minutes, or no target is configured. The API is down, unreachable, or the scrape token is wrong.
First action: open the platform health page, check the last deploy, call `/api/v1/health/live` from outside; a 401 on `/metrics` means the scraper's token is missing or does not match `METRICS_TOKEN` (for example after a rotation).

### DatabaseUnreachable
*page.* Readiness has failed because the database did not answer `SELECT 1` within 2 seconds, for 3 minutes. Sign-in and booking fail; the API itself is up.
First action: database status in the cloud console (failover, full storage, firewall, changed password). Do not restart the API first.

### ReadinessDown
*page.* Any readiness failure for 5 minutes, for example an instance stuck shutting down. It is suppressed when DatabaseUnreachable fires (Alertmanager inhibit rule in `deploy/alerts/alertmanager.dev.yml`; copy it to the real configuration).
First action: call `/api/v1/health/ready` on one instance and read which part fails.

### High5xxRate
*page.* More than 5% of requests (health and metrics routes excluded) fail with 5xx for 10 minutes, with real traffic above 0.1 request per second.
First action: API logs for the last 15 minutes grouped by route; compare with the last deploy and database health.

### HighLatencyP95
*ticket.* p95 above 1 second for 10 minutes. First action: database CPU and connections, then the slowest routes (`durationMs` in the access log).

### RateLimitStoreDegraded
*ticket.* The shared rate-limit store (Redis) is down for 10 minutes; limits apply per instance only. First action: check Redis and its network rules.

### LoginFailureSpike
*page.* At least 30 failed sign-ins in 10 minutes **and** failures are over half of all sign-in attempts, for 5 minutes: password guessing or credential stuffing.
First action: look at failed-login audit events by address and reason; block a dominant address range at Cloudflare; check LockoutSpike and RateLimit429Spike; do not unlock accounts in bulk.

### LockoutSpike
*ticket.* 10 or more accounts got blocked in 10 minutes. Expect calls from locked real users. First action: same as above.

### RateLimit429Spike
*ticket.* More than 100 requests refused by the rate limiter in 10 minutes for the `auth` or `api` group. First action: find the busiest client address; block it or fix the client.

### RefreshReuseDetected
*ticket.* A session token was replayed. The session family is already revoked automatically. First action: find the session-reuse audit event; if the address is not the user's, ask them to change their password. Raise to `page` if you serve high-value accounts.

### PlatformAdminSignIn, PlatformAdminSignInOffHours
*ticket / page.* Every platform-administrator sign-in, and the same outside 06:00 to 20:00 UTC (edit the hours in the rule). First action: confirm with the admin team; if nobody signed in, revoke sessions and rotate the password.

### MfaResetPerformed
*page.* The break-glass script ran in the last 24 hours. It stays firing for 24 hours by design. First action: confirm a ticket exists naming the operator and approver (they are in the audit event); if not, it is an incident. See "Lost authenticator and recovery codes" in [DEPLOYMENT.md](DEPLOYMENT.md).

### MailBudgetExhausted
*ticket.* Mail of one pool was dropped for 5 minutes; the alert carries the pool in its summary. `registration`: verification mail for new sign-ups is spent (`MAIL_BUDGET_REGISTRATION_PER_HOUR`, `_PER_DAY`), so new users may not get their link: real growth or a sign-up flood. `reset`: reset and resend mail for existing accounts is spent (`MAIL_BUDGET_RESET_PER_HOUR`, `_PER_DAY`), so real users cannot recover access: look for forgot-password or resend abuse. The pools are independent, so a spent registration pool does not stop reset mail. First action: look for a flood by client address in the logs and block it at the edge; if the traffic is real, raise that pool within the mail plan.

### MailFailureRate
*ticket.* At least 3 mails failed in 30 minutes and over 25% of attempts. Password resets and verification links are not arriving. First action: provider status page, API key, the "mail ... not delivered" log lines.

## 3. How to tune

Every rule has a comment with the knob. Start from these values, watch for two weeks of real traffic, then adjust:

- Too noisy: raise the count (30 failed logins, 10 lockouts, 100 429s) or the `for:` time; never remove the ratio condition of LoginFailureSpike.
- Too quiet: lower the counts. A small product with 50 sign-ins a day might use 15 failures.
- Thresholds that depend on traffic (High5xxRate floor, HighLatencyP95 1000 ms): set them at about 3 times a normal day.
- After any change run `bash scripts/alerts-test.sh`. When an annotation text changes, copy it into `safry.rules.test.yml` too (promtool compares exactly).

## 4. Proof that exists

- `bash scripts/alerts-test.sh`: 32 promtool cases, each alert fires on simulated data and stays silent below its threshold; it also checks that every metric used by a rule is defined in `metrics.ts`.
- `bash scripts/alerts-fire-test.sh`: starts the real API, Postgres, Prometheus and Alertmanager locally, sends failed sign-ins, stops the database and then the API, and checks that LoginFailureSpike, DatabaseUnreachable and ApiDown reach `firing` and arrive at a webhook sink. Only the `for:` times are shortened to 15 s there.

## 5. Wiring to Azure Monitor (checklist for later)

The target is App Service behind Cloudflare with PostgreSQL Flexible Server ([INFRASTRUCTURE.md](INFRASTRUCTURE.md)). App Service has no
built-in Prometheus scraping, so choose one:

**Option A (recommended start): native Azure Monitor alerts plus log alerts.** No extra server.

- [ ] Action group with the real on-call and ticket receivers (e-mail, SMS, chat webhook).
- [ ] App Service health check pointed at `/api/v1/health/ready`; metric alert on `HealthCheckStatus` below 100 (ApiDown, ReadinessDown).
- [ ] Metric alert on `Http5xx` (Total, 5 min) against `Requests` (High5xxRate); `HttpResponseTime` Average above 1 s (HighLatencyP95; average, not p95).
- [ ] PostgreSQL metric alerts: `is_db_alive` below 1 (DatabaseUnreachable), `cpu_percent`, `storage_percent` and `active_connections` near `max_connections` (the disk or pool signals the app does not export).
- [ ] Send App Service console logs to Log Analytics (diagnostic setting). Log alert (KQL, count over 10 minutes) on the `Access denied 401 POST /api/v1/auth/login` lines for LoginFailureSpike, and on the audit actions `platform.admin.mfa_reset` and `identity.session.reuse_detected` if audit rows are exported.
- [ ] Cloudflare: notifications for origin errors and DDoS; a rate-limiting rule on `/api/v1/auth/*`; block `/api/v1/metrics` publicly.

**Option B: run Prometheus and Alertmanager for these exact rules.** Gives every alert above with identical definitions.

- [ ] A small container (Container Instances or a VM) running Prometheus with `safry.rules.yml` and the bearer-token scrape from `deploy/alerts/prometheus.dev.yml`, and Alertmanager with real receivers.
- [ ] Private network path from it to the API; token in Key Vault.
- [ ] Azure Monitor managed service for Prometheus can host the rule groups, but its scraper targets AKS and similar; it does not reach App Service directly.

Either way, run the fire test on the deployed environment once (stop the database in staging, fail some sign-ins) and write down the result.

## 6. What is NOT covered

- No real notification channel, on-call rota or escalation exists; the sink in the fire test is a log file.
- No Azure resource was created and the Azure steps above have not been tried.
- No alert on host or container memory and CPU, App Service plan limits, certificate expiry, backup freshness or job failures (the API exports no pool or disk metric).
- Database-down detection depends on something probing `/health/ready`. App Service health check or an orchestrator does; without a prober the readiness counter does not move (ApiDown still works).
- Web front end (nginx) and Cloudflare health are not scraped.
- Counters live in each API process and reset on restart; with several instances the rules sum across them, which is what is wanted.
- Failed-login counts include failed password re-checks of signed-in users, so a very large number of those would also trip LoginFailureSpike.
- `MfaResetPerformed` reads the audit trail through the API and needs the database; it disappears while the database is down.
