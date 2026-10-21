// Clears the platform administrator's MFA enrolment (after the MFA encryption key changed) so the sweep enrols it again.
import { parseArgs, loadRunEnv, loadJson, saveJson, ownerClient } from "./common.mjs";
const a = parseArgs();
const run = loadRunEnv(a.run ?? "a");
const db = a.db ?? "safry";
const file = `${run.run}-${db}-actors.json`;
const actors = loadJson(file);
const c = await ownerClient(run.ownerUrl(db));
await c.query('UPDATE users SET "mfaSecretEnc" = NULL, "mfaEnabledAt" = NULL, "mfaLastStep" = NULL, "mfaRecoveryHashes" = \'[]\' WHERE "emailNormalized" = $1', [actors.platform.email]);
delete actors.platformMfaSecret;
saveJson(file, actors);
await c.end();
console.log("platform admin MFA reset");
