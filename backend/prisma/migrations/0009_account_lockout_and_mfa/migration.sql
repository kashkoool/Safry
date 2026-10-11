-- additive columns for login lockout and TOTP multi-factor authentication.
ALTER TABLE "users"
  ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastFailedLoginAt" TIMESTAMPTZ(3),
  ADD COLUMN "lockedUntil" TIMESTAMPTZ(3),
  ADD COLUMN "mfaSecretEnc" VARCHAR(512),
  ADD COLUMN "mfaEnabledAt" TIMESTAMPTZ(3),
  ADD COLUMN "mfaLastStep" INTEGER,
  ADD COLUMN "mfaRecoveryHashes" JSONB NOT NULL DEFAULT '[]';
