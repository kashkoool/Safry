# Platform administrator lost the authenticator and the recovery codes

Short decision guide. The full procedure, with commands and checks, is in [../../docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) under "Lost authenticator and recovery codes (platform administrator)". There is no self-service path and no bypass in the application: a platform administrator cannot turn off their own two-factor sign-in.

## Order of options

1. **A recovery code is still available.** Sign in with it, then regenerate the codes under Account, Security. Nothing else is needed.
2. **The authenticator device is available but the codes are lost.** Sign in, regenerate the codes.
3. **Both are lost.** Use the operator script below. It needs the database owner login (`DATABASE_MIGRATE_URL`), two people (operator and approver) and an out-of-band identity check of the account holder. A password alone is not proof of identity.

## Script (already in the repository)

`backend/scripts/reset-platform-admin-mfa.ts`, run as `pnpm --dir backend admin:reset-mfa -- --email <address> --reason <ticket> --operator <name> --approver <name> --confirm`, or through the one-off `migrate` container as shown in DEPLOYMENT.md.

What it does, in one database transaction (all or nothing):

- refuses unless the account is an active platform administrator;
- ends every sign-in session of the account;
- removes the authenticator secret, recovery codes and any pending sign-in challenge;
- invalidates the current password and unused reset links, so a person who only knows the old password cannot enrol their own authenticator;
- writes an audit event `platform.admin.mfa_reset` with reason, operator and approver.

It prints no secret.

## After the reset

1. The administrator uses "Forgot password" and sets a new password from the e-mailed link.
2. They sign in; platform routes answer `403 mfa_enrollment_required` until they enrol a new authenticator.
3. They store the new recovery codes somewhere safe, offline.
4. Record the request, who verified the identity and how, the approver, the operator, the time and the ticket. Review every `platform.admin.mfa_reset` audit event against a ticket.

## Prevention

Keep at least two platform administrators and keep recovery codes in two separate safe places.
