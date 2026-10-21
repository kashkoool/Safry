// Gives the load harness real, signed-in-able actors (traveler, provider, organization manager, tenant admin, platform admin).
//   node actors.mjs --run a --db safry          adopts existing history users of tenant hist-t001 (the heaviest travelers, the staff of three organizations)
//   node actors.mjs --run a --db safry_fresh    builds a minimal demo tenant (3 organizations, 30 services, 40 travelers, 50 bookings)
// Direct SQL as the database owner (row-level security does not apply). The password is generated per run and written to .data/aged/ (git-ignored).
import { randomBytes, randomUUID } from "node:crypto";
import { parseArgs, loadRunEnv, ownerClient, saveJson } from "./common.mjs";

const args = parseArgs();
const run = loadRunEnv(args.run ?? "a");
const db = args.db ?? "safry";
const fresh = db === "safry_fresh";
const { hashPassword } = await import(new URL("../../../dist/common/security/password.js", import.meta.url).href);
const { PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } = await import(new URL("../../../dist/modules/identity/access/system-roles.js", import.meta.url).href);

const password = randomBytes(18).toString("base64url");
const passwordHash = await hashPassword(password);
const c = await ownerClient(run.ownerUrl(db));
const q = (t, v) => c.query(t, v);

await q("BEGIN");
await q("SELECT set_config('app.bypass_rls', 'on', true)");
for (const [code, description] of PERMISSIONS)
  await q("INSERT INTO permissions (id, code, description) VALUES (gen_random_uuid(), $1, $2) ON CONFLICT (code) DO NOTHING", [code, description]);

async function systemRoles(tenantId) {
  const ids = {};
  for (const [code, name] of SYSTEM_ROLES) {
    const r = await q('INSERT INTO roles (id, "tenantId", code, name, "isSystem", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, true, now()) ON CONFLICT ("tenantId", code) DO UPDATE SET "isSystem" = true RETURNING id', [tenantId, code, name]);
    ids[code] = r.rows[0].id;
    await q('INSERT INTO role_permissions ("roleId", "permissionId") SELECT $1, id FROM permissions WHERE code = ANY($2) ON CONFLICT DO NOTHING', [ids[code], [...ROLE_PERMISSIONS[code]]]);
  }
  return ids;
}
async function newUser(email, name, extra = {}) {
  const r = await q(
    `INSERT INTO users (id, email, "emailNormalized", "passwordHash", "displayName", "isPlatformAdmin", status, "emailVerifiedAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $1, $2, $3, $4, 'ACTIVE', now(), now()) RETURNING id`,
    [email, passwordHash, name, extra.platform ?? false]
  );
  return r.rows[0].id;
}
async function newMembership(tenantId, userId, roleId, orgId = null) {
  const m = await q('INSERT INTO tenant_memberships (id, "tenantId", "userId", status, "providerOrganizationId", "updatedAt") VALUES (gen_random_uuid(), $1, $2, \'ACTIVE\', $3, now()) RETURNING id', [tenantId, userId, orgId]);
  await q('INSERT INTO membership_roles ("membershipId", "roleId", "tenantId") VALUES ($1, $2, $3)', [m.rows[0].id, roleId, tenantId]);
  return m.rows[0].id;
}
/** Adopts an existing history user: real password, verified, ACTIVE, plus one more role on its existing membership of the tenant. */
async function adopt(email, tenantId, roleId) {
  const u = await q('UPDATE users SET "passwordHash" = $2, "emailVerifiedAt" = now(), status = \'ACTIVE\', "deletedAt" = NULL, "disabledAt" = NULL, "updatedAt" = now() WHERE "emailNormalized" = $1 RETURNING id', [email, passwordHash]);
  if (u.rowCount !== 1) throw new Error(`no history user ${email}`);
  const m = await q('UPDATE tenant_memberships SET status = \'ACTIVE\', "revokedAt" = NULL, "updatedAt" = now() WHERE "userId" = $1 AND "tenantId" = $2 RETURNING id, "providerOrganizationId"', [u.rows[0].id, tenantId]);
  if (m.rowCount !== 1) throw new Error(`no membership for ${email}`);
  await q('INSERT INTO membership_roles ("membershipId", "roleId", "tenantId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [m.rows[0].id, roleId, tenantId]);
  return { userId: u.rows[0].id, membershipId: m.rows[0].id, organizationId: m.rows[0].providerOrganizationId };
}

const out = { db, fresh, password, travelers: [] };
let tenantId;
if (fresh) {
  out.tenantCode = "fresh-t";
  tenantId = (await q('INSERT INTO tenants (id, code, name, "updatedAt") VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id', [out.tenantCode, "Fresh demo tenant"])).rows[0].id;
} else {
  out.tenantCode = "hist-t001";
  tenantId = (await q("SELECT id FROM tenants WHERE code = $1", [out.tenantCode])).rows[0].id;
}
out.tenantId = tenantId;
const roles = await systemRoles(tenantId);

if (fresh) {
  const orgIds = [];
  for (let o = 1; o <= 3; o++) {
    const r = await q(
      `INSERT INTO provider_organizations (id, "tenantId", name, "nameAr", "nameEn", type, city, "contactEmail", "licenseNumber", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $2, $2, 'TRAVEL_COMPANY', 'Riyadh', $3, $4, now()) RETURNING id`,
      [tenantId, `Fresh Provider ${o}`, `fresh-provider-${o}@example.test`, `LIC-F${o}`]
    );
    orgIds.push(r.rows[0].id);
  }
  const staff = [];
  for (let o = 0; o < 3; o++) {
    const uid = await newUser(`fresh-staff-${o + 1}@example.test`, `Fresh Staff ${o + 1}`);
    const mid = await newMembership(tenantId, uid, o === 2 ? roles["organization-manager"] : roles["service-provider"], orgIds[o]);
    if (o === 2) await q('INSERT INTO membership_roles ("membershipId", "roleId", "tenantId") VALUES ($1, $2, $3)', [mid, roles["travel-company"], tenantId]);
    staff.push({ userId: uid, membershipId: mid });
  }
  const travelerMemberships = [];
  for (let t = 1; t <= 40; t++) {
    const uid = await newUser(`fresh-traveler-${t}@example.test`, `Fresh Traveler ${t}`);
    travelerMemberships.push(await newMembership(tenantId, uid, roles.traveler));
    out.travelers.push({ email: `fresh-traveler-${t}@example.test` });
  }
  for (let t = 1; t <= 10; t++) {
    const uid = await newUser(`fresh-spare-${t}@example.test`, `Fresh Spare ${t}`);
    await newMembership(tenantId, uid, roles.traveler);
  }
  const serviceIds = [];
  for (let s = 0; s < 30; s++) {
    const r = await q(
      `INSERT INTO travel_services (id, "tenantId", "providerMembershipId", "providerOrganizationId", title, description, category, city, "priceCents", status, capacity, details, "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'Fresh demo package for the baseline run', 'PACKAGE', 'Makkah', 150000, 'ACTIVE', 1000, '{"durationDays":"5","departureCity":"Riyadh","itinerary":"x"}', now()) RETURNING id`,
      [tenantId, staff[s % 3].membershipId, orgIds[s % 3], `Fresh Service ${s + 1}`]
    );
    serviceIds.push(r.rows[0].id);
  }
  for (let b = 0; b < 50; b++)
    await q(
      `INSERT INTO bookings (id, "tenantId", "serviceId", "travelerMembershipId", "travelersCount", "totalCents", "unitPriceCents", units, "serviceDate", status, "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, 2, 300000, 150000, 1, current_date + 30, $4, now())`,
      [tenantId, serviceIds[b % 30], travelerMemberships[b % 40], b % 3 === 0 ? "CONFIRMED" : "PENDING"]
    );
  const admin = await newUser("fresh-admin@example.test", "Fresh Admin");
  await newMembership(tenantId, admin, roles["tenant-admin"]);
  out.admin = { email: "fresh-admin@example.test" };
  out.provider = { email: "fresh-staff-1@example.test", organizationId: orgIds[0] };
  out.orgmgr = { email: "fresh-staff-3@example.test", organizationId: orgIds[2] };
  out.orgId = orgIds[0];
  out.otherOrgId = orgIds[1];
} else {
  // Travelers: the 40 history users of this tenant with the most bookings (they also carry the most sessions and audit rows).
  const heavy = await q(
    `SELECT u."emailNormalized" AS email FROM bookings b
       JOIN tenant_memberships m ON m.id = b."travelerMembershipId" JOIN users u ON u.id = m."userId"
      WHERE b."tenantId" = $1 AND u."emailNormalized" LIKE 'user%' AND m."providerOrganizationId" IS NULL
      GROUP BY u."emailNormalized" ORDER BY count(*) DESC LIMIT 40`,
    [tenantId]
  );
  for (const row of heavy.rows) {
    await adopt(row.email, tenantId, roles.traveler);
    out.travelers.push({ email: row.email });
  }
  const orgs = (await q('SELECT id FROM provider_organizations WHERE "tenantId" = $1 ORDER BY name', [tenantId])).rows.map((r) => r.id);
  // history staff accounts: staff000001 -> org of index 0, staff000006 -> index 5, staff000011 -> index 10 (all in tenant 0)
  const provider = await adopt("staff000001@example.test", tenantId, roles["service-provider"]);
  const mgr = await adopt("staff000006@example.test", tenantId, roles["organization-manager"]);
  await adopt("staff000006@example.test", tenantId, roles["travel-company"]); // a registered provider holds its provider role AND organization-manager
  out.provider = { email: "staff000001@example.test", organizationId: provider.organizationId };
  out.orgmgr = { email: "staff000006@example.test", organizationId: mgr.organizationId };
  out.orgId = provider.organizationId;
  out.otherOrgId = orgs.find((id) => id !== provider.organizationId && id !== mgr.organizationId);
  const admin = await newUser("aged-admin@example.test", "Aged Admin");
  await newMembership(tenantId, admin, roles["tenant-admin"]);
  out.admin = { email: "aged-admin@example.test" };
}

// Platform operations tenant with one platform administrator (MFA is enrolled through the API by the sweep).
const ops = (await q('INSERT INTO tenants (id, code, name, "updatedAt") VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id', ["platform-ops", "Platform operations"])).rows[0].id;
const opsRoles = await systemRoles(ops);
const pa = await newUser(`platform-admin@example.test`, "Platform Admin", { platform: true });
await newMembership(ops, pa, opsRoles["tenant-admin"]);
out.platform = { email: "platform-admin@example.test", tenantCode: "platform-ops", tenantId: ops };
out.createdAt = new Date().toISOString();
await q("COMMIT");
await c.end();
saveJson(`${run.run}-${db}-actors.json`, out);
console.log(`actors ready for run ${run.run}, db ${db}: ${out.travelers.length} travelers, tenant ${out.tenantCode}`);
