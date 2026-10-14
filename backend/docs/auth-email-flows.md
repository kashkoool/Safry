# Password reset and e-mail verification

Four public endpoints under `/api/v1/auth` (also in Swagger when it is enabled). Request bodies are JSON. The two `202` endpoints
return a small JSON body; the reset and verify endpoints return `204` with no body at all (a client must not parse an empty
body as JSON). None needs a bearer token or a tenant, and all run in the explicit system scope (an e-mail address is one identity across tenants).

| Method and path | Body | Success | Limits (per minute) |
|---|---|---|---|
| `POST /auth/password/forgot` | `{ "email": string }` | `202 { "accepted": true }` | 5 per client address, 3 per (e-mail, client address) |
| `POST /auth/password/reset` | `{ "token": string(43), "newPassword": string(12..128) }` | `204` no body | 10 per client address |
| `POST /auth/email/verify` | `{ "token": string(43) }` | `204` no body | 20 per client address |
| `POST /auth/email/resend` | `{ "email": string }` | `202 { "accepted": true }` | 5 per client address, 3 per (e-mail, client address) |

Errors: `400` validation (unknown field, wrong type, wrong length, password policy), `400` with message
`Reset link is invalid or expired` / `Verification link is invalid or expired` for an unknown, used, expired, altered or
foreign token (one answer for every cause), `429` rate limit. `forgot` and `resend` never answer anything but `202` for a
well-formed body.

## Status

The frontend pages for `/reset-password` and `/verify-email` (the token travels in the URL fragment) and the resend action are
delivered in a separate frontend pull request. Until it lands, the emailed links have no page to open.

## Links and tokens

- A token is 32 random bytes in base64url (43 characters). Only its SHA-256 is stored (`credential_tokens.tokenHash`), compared
  in constant time, valid once. Reset links live 60 minutes, verification links 24 hours.
- The link carries the token in the URL **fragment**, which browsers never send to a server, so it stays out of access logs and
  `Referer` headers: `${APP_BASE_URL}/reset-password#token=<43 chars>` and `${APP_BASE_URL}/verify-email#token=<43 chars>`.
  The frontend reads `location.hash`, removes it from the address bar (`history.replaceState`) and POSTs the token in the body.
- A new link of the same purpose voids older unused ones. A link also dies when the account is disabled or deleted, or when its
  e-mail address changed after the link was issued.
- Per account, whoever asks: at most one link per minute and five per hour (further requests still answer `202`, nothing is sent,
  and the audit log records `...suppressed`).

## No account enumeration

`forgot` and `resend` answer identically (status, body, headers) whether or not the address belongs to an account, take at least
`AUTH_MAIL_MIN_RESPONSE_MS` (default 300 ms) in both cases, write one audit row in both cases, and hand the message to the mail
provider after the answer is decided. A tenant-created or already verified account asking for `resend` gets the same `202`
and no mail.

## What a password reset does

In one transaction under the user-row lock: claims the token, stores the new password hash (same argon2id parameters and same
policy as every other password field), increments `authVersion` (all access tokens stop working at once), ends every refresh
session of the user in every tenant, voids other reset links, and marks the address verified if it was not (receiving the link
proves the mailbox). Afterwards it lifts the sign-in lockout of the account and of the address that completed the reset, and sends a
"your password was changed" notice. MFA settings are untouched. Audit actions: `identity.password.reset_requested` (also
`.suppressed`), `identity.password.reset`.

## Verification rule

- A **self-registered** account (`POST /auth/register/customer|provider`) starts unverified and receives a confirmation link. It
  cannot sign in until the link is used: `POST /auth/login` answers the same `401 Invalid credentials or tenant` as for a wrong
  password (the audit row `identity.login.failed` carries `reason: email_unverified`), so the login answer does not reveal that the
  account exists. The client offers "send me a new link" (`/auth/email/resend`) next to every failed sign-in.
- Accounts created by a tenant administrator, by a platform administrator, by the seed or by the bootstrap script are created
  **already verified**. Accounts that existed when verification shipped were marked verified by migration
  `20261014_auth_backfill_email_verified`.
- A platform administrator changing an account's address makes it unverified again and mails a link to the new address.
- Registration of an identity that already exists (linking it to one more tenant after proof of its password) sends no mail
  when that identity is verified and says it can sign in immediately.
- A failure to issue or hand over a link after registration or an address change never turns the committed change into an
  error: it is logged (error class only) and the user asks for a new link through `/auth/email/resend`.

## Known trade-offs

- **Pre-registration.** Anyone can self-register an address they do not own, with a password of their choice. That account stays
  unverified and cannot sign in. If the real owner later uses the confirmation link without resetting the password, the account
  becomes verified with the registrant's password. Mitigations: the confirmation mail says to ignore it if the recipient did not
  create an account, and a password reset replaces the password, voids other links and ends every session. Recipients who did not
  register should ignore the mail or reset the password.
- **Backfill migration.** `20261014_auth_backfill_email_verified` marks every existing user verified. Run it only on the initial
  empty database, or after counting the unverified users (`SELECT count(*) FROM users WHERE "emailVerifiedAt" IS NULL`) and
  deciding that none of them is an unproven self-registration; otherwise restrict the `UPDATE` to known accounts first.
- **Per-account link cap.** One link a minute and five an hour per account bound mail volume, but a third party who knows an
  address can use up the hourly allowance and delay a new link for that account for up to an hour (the most recent link keeps
  working). This is accepted; the per-address limits (5 requests a minute per client address, 3 per e-mail and client address)
  limit how fast one source can do it.

## Mail

Templates are plain text plus simple HTML in Arabic or English by `users.locale` (`ar*` selects Arabic, right-to-left; anything
else English). No remote images, no tracking pixels, no rewritten links; every interpolated value is HTML-escaped. Transport and
settings: `docs/DEPLOYMENT.md`, section "Transactional email (Resend)". Nothing logs an API key or a message body; the console
transport (development and tests only) logs the recipient, subject and link, and is refused in production.

## Retention

`purge_credential_tokens(interval)` (owner-only procedure, called by `scripts/db/purge.sh`) deletes tokens seven days after they
expired or were used. The table has forced row-level security with a policy that admits only the explicit system scope
(`app.bypass_rls = on`): a tenant-scoped request cannot read or write token rows.
