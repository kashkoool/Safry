// One-off: gives the organization-manager actor the travel-company role too (as provider registration does). Idempotent.
import { parseArgs, loadRunEnv, loadJson, ownerClient } from "./common.mjs";
const a = parseArgs();
const run = loadRunEnv(a.run ?? "a");
const db = a.db ?? "safry";
const actors = loadJson(`${run.run}-${db}-actors.json`);
const c = await ownerClient(run.ownerUrl(db));
await c.query("SELECT set_config('app.bypass_rls', 'on', false)");
const r = await c.query(
  `INSERT INTO membership_roles ("membershipId", "roleId", "tenantId")
   SELECT m.id, r.id, m."tenantId" FROM users u JOIN tenant_memberships m ON m."userId" = u.id AND m."tenantId" = $2
     JOIN roles r ON r."tenantId" = m."tenantId" AND r.code = 'travel-company'
    WHERE u."emailNormalized" = $1 ON CONFLICT DO NOTHING`, [actors.orgmgr.email, actors.tenantId]);
console.log("rows added", r.rowCount);
await c.end();
