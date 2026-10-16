-- Lets an administrator unlock an e-mail completely: each (e-mail, address) row now records the hash of its e-mail's
-- account-wide key, so every address row of that e-mail can be found without knowing the addresses. Additive and nullable;
-- rows written before this change keep NULL and simply expire on their own (blocks always expire). The index is created on a
-- small, short-lived table (rows are pruned after a day).
ALTER TABLE "login_throttles" ADD COLUMN "accountKey" CHAR(64);
CREATE INDEX "login_throttles_accountKey_idx" ON "login_throttles"("accountKey");
