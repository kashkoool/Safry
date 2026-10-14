-- Single-use e-mailed links: password reset and e-mail verification. Additive (new type, new table, new procedure).
-- Only the SHA-256 of the token is stored. The table is identity-level (one e-mail identity spans tenants), so it has no tenant
-- column; row-level security is forced and its policy admits only the explicit system scope (app.bypass_rls = on), so a
-- tenant-scoped request can never read or write a token row (fail closed).
CREATE TYPE "CredentialTokenPurpose" AS ENUM ('PASSWORD_RESET', 'EMAIL_VERIFICATION');

CREATE TABLE "credential_tokens" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "purpose" "CredentialTokenPurpose" NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credential_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credential_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "credential_tokens_tokenHash_key" ON "credential_tokens"("tokenHash");
CREATE INDEX "credential_tokens_userId_purpose_createdAt_idx" ON "credential_tokens"("userId", "purpose", "createdAt");
CREATE INDEX "credential_tokens_expiresAt_idx" ON "credential_tokens"("expiresAt");

ALTER TABLE "credential_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credential_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON "credential_tokens";
CREATE POLICY system_only ON "credential_tokens" USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());

GRANT SELECT, INSERT, UPDATE, DELETE ON "credential_tokens" TO safry_app;

-- Retention: owner-only, batched. Rows are useless once expired (or used); keeping a short tail helps support questions.
-- CALL purge_credential_tokens(interval '7 days');
CREATE OR REPLACE PROCEDURE purge_credential_tokens(retention interval, batch_size integer DEFAULT 5000)
LANGUAGE plpgsql
AS $$
DECLARE
  removed bigint;
BEGIN
  IF retention < interval '1 day' THEN
    RAISE EXCEPTION 'credential token retention must be at least 1 day';
  END IF;
  PERFORM set_config('app.bypass_rls', 'on', false);
  LOOP
    DELETE FROM "credential_tokens"
    WHERE "id" IN (
      SELECT "id" FROM "credential_tokens"
      WHERE "expiresAt" < now() - retention
         OR ("usedAt" IS NOT NULL AND "usedAt" < now() - retention)
      LIMIT batch_size
    );
    GET DIAGNOSTICS removed = ROW_COUNT;
    COMMIT;
    EXIT WHEN removed = 0;
  END LOOP;
  PERFORM set_config('app.bypass_rls', 'off', false);
END
$$;

REVOKE ALL ON PROCEDURE purge_credential_tokens(interval, integer) FROM PUBLIC, safry_app;
