# Data retention and erasure policy

Status: engineering proposal. **Every period below is a proposed default, not a legal decision.** Qatar retention periods for
bookings, financial records and security logs have not been confirmed; counsel must confirm them before go-live, and the settings
are then changed in `.env` without a code change. Until then the defaults err on the side of removing personal data early while
keeping the business and audit records.

## What is kept, what goes

| Data | Kept | Removed | Setting (default) |
|---|---|---|---|
| Bookings, their status history and amounts | Always. Never hard-deleted by any job. They still resolve to the user row (below). | nothing | none |
| Payment and financial records (when payments exist) | Always, same rule as bookings. | nothing | none |
| Audit trail (`audit_events`) | Action, time, entity, tenant, actor id: for `AUDIT_RETENTION_DAYS` (unset = 24 months, whole monthly partitions are dropped). | IP address after `AUDIT_IP_RETENTION_DAYS`; free text and personal values in the metadata of an anonymised user's rows. | `AUDIT_RETENTION_DAYS` (24 months), `AUDIT_IP_RETENTION_DAYS` (90 days, 0 = never) |
| User row of a deleted account | The row stays, so bookings, memberships and audit rows still resolve. It becomes a tombstone. | e-mail, phone, display name, password hash, MFA secret and recovery codes (see below) | `ANONYMISE_DELETED_USERS_AFTER_DAYS` (30 days, 0 = never) |
| Refresh sessions (browser sign-ins, with user agent and IP) | Until `SESSION_RETENTION_DAYS` after they expire or are revoked. All sessions of an anonymised user are deleted at once. | | `SESSION_RETENTION_DAYS` (30 days) |
| Password reset and e-mail verification links | Until `CREDENTIAL_TOKEN_RETENTION_DAYS` after they expire or are used. Deleted at once for an anonymised user. | | `CREDENTIAL_TOKEN_RETENTION_DAYS` (7 days) |
| Database backups | `BACKUP_KEEP_DAYS` (14 days), capped by `BACKUP_MAX_TOTAL_MB`. | Older dumps are deleted. | see "Backups" |
| Container logs | See "Logs and security events". | | `LOG_MAX_SIZE`, `LOG_MAX_FILES` |

## Erasure of a deleted account

Deleting an account in the platform console is a soft delete (`deletedAt` is set, the account is disabled, its sessions are revoked).
The daily maintenance job (`backend/scripts/db/purge.sh`, function `anonymise_deleted_users_batch`, run by the procedures-only `safry_maintenance` login) anonymises every account that has been
deleted for more than `ANONYMISE_DELETED_USERS_AFTER_DAYS`. The delay is a grace period: until then a platform administrator can
restore the account. After anonymisation the account **cannot be restored** (the platform API answers 409).

What the procedure does, in batches of `PURGE_BATCH_SIZE`, and safe to repeat:

- e-mail and normalised e-mail become `deleted-<user id>@anonymised.invalid`; display name becomes `Deleted user`; phone is cleared;
  the locale is kept;
- the password hash is replaced by a value that no password verifies against; MFA secret, enrolment time, recovery codes and any
  pending MFA challenge are cleared; the account is `DISABLED`; its token version is bumped so any access token still alive stops working;
- all refresh sessions (and so their user agent and IP) and all password-reset / verification links of the user are deleted;
- in the audit rows that name the user (as actor, or as the user entity), the keys `reason`, `email`, `displayName`, `phone`, `name` and
  a profile `before` block are removed from the metadata. The rows themselves, with action and time, stay;
- `anonymisedAt` is set, which is what makes a second run a no-op.

Not removed: memberships, bookings (they stay attached to the tombstone), the user id and the audit trail entries. **Limits:** personal
data a user typed into another record (for example a booking note, if one is ever added) is not found by this job; a new field that holds
personal data needs its own step. Audit rows written by other people about the user keep what those rows say outside the keys above.

Run `PURGE_DRY_RUN=1 sh backend/scripts/db/purge.sh` (or `docker compose run --rm -e PURGE_DRY_RUN=1 --entrypoint sh maintenance /scripts/purge.sh`)
to see how many accounts and audit rows the next run would change, without changing anything.

## Audit trail: IP addresses and immutability

The audit table is append-only for the application: the `safry_app` role has no `UPDATE`, `DELETE` or `TRUNCATE` on it, and that is
unchanged. IP addresses are cleared by `scrub_audit_ip_addresses_batch`, a bounded `SECURITY DEFINER` function that runs with the database owner's rights (the
same pattern as the retention drops; its floor is the `audit_ip_retention` row of `maintenance_policy`). It sets only `ipAddress` to null on rows older than `AUDIT_IP_RETENTION_DAYS`, for all
users, and never changes the action, time, entity or tenant. Rows are never removed by it; whole months are dropped only by the
`AUDIT_RETENTION_DAYS` rule. Setting `AUDIT_IP_RETENTION_DAYS=0` keeps IP addresses for the whole audit retention.

Disk note: clearing an IP leaves a dead row version in an old partition; autovacuum reclaims it for reuse (the file does not shrink).

## Backups

A deleted or anonymised account's data stays in older backups until they age out. With the defaults this is up to 14 days
(`BACKUP_KEEP_DAYS`) plus the deployment's anonymisation delay; backups are never edited. This is a stated limit, not a bug: state it in
the privacy notice. A restore of an old backup must be followed by running the maintenance job again, which anonymises accounts that were
already deleted at the time of the dump (the `deletedAt` date is part of the dump) but not accounts deleted after it: re-apply those from the audit
trail (`platform.account.delete`) if a restore ever happens.

Size is capped by `BACKUP_MAX_TOTAL_MB` (default 5120, 0 = no cap): the oldest sets go first, the newest is never deleted, and a dump that cannot
be written fails loudly. Alerts: `BackupMissing`, `BackupVolumeNearlyFull` (`docs/ALERTING.md`).

## Logs and security events

Where the security trail lives, and for how long:

| Source | Content | Kept where | Retention |
|---|---|---|---|
| `audit_events` table | logins, refreshes, failed logins of known accounts, admin and booking actions, IP (until `AUDIT_IP_RETENTION_DAYS`) | the database (and its backups) | `AUDIT_RETENTION_DAYS` (24 months) |
| Metrics (`/api/v1/metrics`) | counters for failed logins, lockouts, 429s, skipped audit writes | only if a scraper stores them (none in compose) | the scraper's setting |
| API container log | one JSON line per request: method, route template, status, duration, request id, tenant id. No IP, no e-mail, no body, no token | docker `json-file` on the host | the last `LOG_MAX_SIZE` x `LOG_MAX_FILES` (default 50 MB): hours under load |
| Web (nginx) and TLS proxy (Caddy) logs | access lines with client address and path | same | same |

What is lost when: failed logins for **unknown** accounts are not audited row by row (they are counted in metrics); container logs older than
the docker cap are gone without trace; a restore from backup brings back audit rows only up to the dump time.

Production sink options (no paid service is added by this repository; pick one before go-live and record the choice here):

1. **The hosting provider's log service** (for example Azure Monitor / Log Analytics, a managed Loki, or the cloud's logging agent):
   the simplest. Ship container stdout, set the workspace retention to the longest period counsel approves for access logs
   (proposed 90 days for web/proxy logs, 30 days for API lines) and restrict who can read it.
2. **Self-hosted Loki + Promtail (or Vector) on a separate small host**: no licence cost, but you operate it; use the same retention.
3. **Docker's `local` or `journald` driver with a host log shipper**: raise `LOG_MAX_SIZE` / `LOG_MAX_FILES` in `.env` (for example 50m x 20) so the host keeps days, not hours, until a shipper exists.

Whatever is chosen, web and proxy logs contain IP addresses and count as personal data: give them a retention no longer than
`AUDIT_IP_RETENTION_DAYS` unless counsel says otherwise.

## Operating checklist (before go-live)

- [ ] Counsel has confirmed (or replaced) the periods above; `.env` holds the final values.
- [ ] `docker compose logs maintenance` shows `purge done`; `PurgeJobStale` and `ErasurePastRetention` are wired to a notification channel.
- [ ] `docker compose ps backup` is healthy; dumps are copied off the host; `BackupMissing` is wired.
- [ ] A log sink and its retention are chosen and written into this page.
- [ ] The privacy notice states the backup limit and the grace period.
