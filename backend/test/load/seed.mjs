// Seeds a throwaway PostgreSQL with a realistic dataset and mints access tokens for load tests.
//   LOAD_DATABASE_URL=postgresql://... LOAD_JWT_SECRET=<same secret the API runs with> node seed.mjs
// Defaults: 4 tenants, ~10,000 users, 50,000 bookings. Run `prisma migrate deploy` first.
// Direct set-based SQL as the database owner, so row-level security does not apply to the seeder.
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";

const url = process.env.LOAD_DATABASE_URL;
const secret = process.env.LOAD_JWT_SECRET;
if (!url || !secret || secret.length < 32) {
  console.error("Set LOAD_DATABASE_URL and LOAD_JWT_SECRET (>= 32 chars; must equal JWT_ACCESS_SECRET of the API under test).");
  process.exit(1);
}
const TENANTS = Number(process.env.LOAD_TENANTS ?? 4);
const TRAVELERS = Number(process.env.LOAD_TRAVELERS_PER_TENANT ?? 2400);
const ORGS = Number(process.env.LOAD_ORGS_PER_TENANT ?? 20);
const SERVICES_PER_ORG = Number(process.env.LOAD_SERVICES_PER_ORG ?? 20);
const BOOKINGS = Number(process.env.LOAD_BOOKINGS_PER_TENANT ?? 12500);
const HOT_BOOKINGS = Number(process.env.LOAD_HOT_BOOKINGS ?? 3000);
const TOKENS_PER_TENANT = Number(process.env.LOAD_TOKENS_PER_TENANT ?? 200);

const PERMISSIONS = {
  "tenant.read": ["tenant-admin", "service-provider", "traveler"],
  "catalog.service.read": ["tenant-admin", "service-provider", "traveler"],
  "catalog.service.manage": ["tenant-admin", "service-provider"],
  "booking.read": ["tenant-admin", "service-provider", "traveler"],
  "booking.create": ["tenant-admin", "traveler"],
  "booking.manage": ["tenant-admin", "service-provider"],
  "identity.user.read": ["tenant-admin"],
  "audit.read": ["tenant-admin"]
};
const ROLES = ["tenant-admin", "service-provider", "traveler"];

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function sign(payload) {
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = (text, values) => client.query(text, values);
const t0 = Date.now();

// Real argon2 hash of a throwaway password so /auth/login can be exercised too.
let passwordHash = "x".repeat(60);
try {
  const argon2 = createRequire(new URL("../../package.json", import.meta.url))("argon2");
  passwordHash = await argon2.hash(process.env.LOAD_USER_PASSWORD ?? "Load-Test-Only-Pw-1");
} catch {
  console.warn("argon2 not found in ../../node_modules; users get an unusable password hash");
}

await q("TRUNCATE tenants, users, permissions RESTART IDENTITY CASCADE");
for (const code of Object.keys(PERMISSIONS)) await q("INSERT INTO permissions (id, code) VALUES (gen_random_uuid(), $1)", [code]);

const tokens = [];
const hot = {};
for (let t = 0; t < TENANTS; t++) {
  const tenantId = randomUUID();
  const code = `load-${t}`;
  await q('INSERT INTO tenants (id, code, name, "updatedAt") VALUES ($1,$2,$3, now())', [tenantId, code, `Load tenant ${t}`]);
  const roleIds = {};
  for (const role of ROLES) {
    roleIds[role] = randomUUID();
    await q('INSERT INTO roles (id, "tenantId", code, name, "isSystem", "updatedAt") VALUES ($1,$2,$3,$3,true, now())', [roleIds[role], tenantId, role]);
    await q('INSERT INTO role_permissions ("roleId","permissionId") SELECT $1, id FROM permissions WHERE code = ANY($2)', [
      roleIds[role],
      Object.entries(PERMISSIONS).filter(([, r]) => r.includes(role)).map(([c]) => c)
    ]);
  }
  await q(
    `INSERT INTO provider_organizations (id,"tenantId",name,"nameAr","nameEn",type,city,"contactEmail","updatedAt")
     SELECT gen_random_uuid(), $1, 'Org '||g, 'Org '||g, 'Org '||g, 'TRAVEL_COMPANY', 'Riyadh', 'org'||g||'@example.test', now() FROM generate_series(1,$2) g`,
    [tenantId, ORGS]
  );
  for (const [kind, count] of [["admin", 1], ["prov", ORGS], ["trav", TRAVELERS]]) {
    await q(
      `INSERT INTO users (id,email,"emailNormalized","passwordHash","displayName","updatedAt")
       SELECT gen_random_uuid(), $1::text||'-'||$2::text||'-'||g||'@example.test', $1::text||'-'||$2::text||'-'||g||'@example.test', $3, $1::text||' '||g, now()
       FROM generate_series(1,$4::int) g`,
      [kind, String(t), passwordHash, count]
    );
  }
  await q(
    `INSERT INTO tenant_memberships (id,"tenantId","userId",status,"providerOrganizationId","updatedAt")
     SELECT gen_random_uuid(), $1, u.id, 'ACTIVE',
       CASE WHEN u.email LIKE 'prov-%' THEN (SELECT o.id FROM (SELECT id, row_number() OVER (ORDER BY name) rn FROM provider_organizations WHERE "tenantId"=$1) o
         WHERE o.rn = split_part(split_part(u.email,'-',3),'@',1)::int) END, now()
     FROM users u WHERE u.email ~ ('^(admin|prov|trav)-' || $2::text || '-')`,
    [tenantId, String(t)]
  );
  await q(
    `INSERT INTO membership_roles ("membershipId","roleId","tenantId")
     SELECT m.id, CASE WHEN u.email LIKE 'admin-%' THEN $2::uuid WHEN u.email LIKE 'prov-%' THEN $3::uuid ELSE $4::uuid END, $1
     FROM tenant_memberships m JOIN users u ON u.id = m."userId" WHERE m."tenantId"=$1`,
    [tenantId, roleIds["tenant-admin"], roleIds["service-provider"], roleIds["traveler"]]
  );
  await q(
    `INSERT INTO travel_services (id,"tenantId","providerMembershipId","providerOrganizationId",title,description,category,city,"priceCents",status,capacity,details,"updatedAt")
     SELECT gen_random_uuid(), $1, m.id, o.id, 'Service '||g, 'Load test package', 'PACKAGE', 'Makkah', 100000, 'ACTIVE', 1000000,
       '{"durationDays":"5","departureCity":"Riyadh","itinerary":"x"}', now()
     FROM provider_organizations o JOIN tenant_memberships m ON m."providerOrganizationId" = o.id, generate_series(1,$2::int) g WHERE o."tenantId"=$1`,
    [tenantId, SERVICES_PER_ORG]
  );
  await q(`CREATE TEMP TABLE svc AS SELECT id, row_number() OVER (ORDER BY id) rn FROM travel_services WHERE "tenantId"=$1`, [tenantId]);
  await q(
    `CREATE TEMP TABLE trav AS SELECT m.id, row_number() OVER (ORDER BY m.id) rn FROM tenant_memberships m JOIN users u ON u.id=m."userId"
     WHERE m."tenantId"=$1 AND u.email LIKE 'trav-%'`,
    [tenantId]
  );
  // The "hot" service (rn 1) carries HOT_BOOKINGS bookings; the rest are spread over every service.
  await q(
    `INSERT INTO bookings (id,"tenantId","serviceId","travelerMembershipId","travelersCount","totalCents","unitPriceCents",units,"serviceDate",status,"createdAt","updatedAt")
     SELECT gen_random_uuid(), $1, (SELECT id FROM svc WHERE rn = 1), (SELECT id FROM trav WHERE rn = 1 + (g % $3::int)), 1, 100000, 100000, 1,
       current_date + (g % 90), 'PENDING', now() - (g || ' seconds')::interval, now()
     FROM generate_series(1,$2::int) g`,
    [tenantId, HOT_BOOKINGS, TRAVELERS]
  );
  await q(
    `INSERT INTO bookings (id,"tenantId","serviceId","travelerMembershipId","travelersCount","totalCents","unitPriceCents",units,"serviceDate",status,"createdAt","updatedAt")
     SELECT gen_random_uuid(), $1, (SELECT id FROM svc WHERE rn = 1 + (g % (SELECT count(*) FROM svc))), (SELECT id FROM trav WHERE rn = 1 + ((g*7) % $3::int)), 1, 100000, 100000, 1,
       current_date + (g % 90), (ARRAY['PENDING','CONFIRMED','CANCELLED'])[1 + (g % 3)]::"BookingStatus", now() - ((g + $4::int) || ' seconds')::interval, now()
     FROM generate_series(1,$2::int) g`,
    [tenantId, BOOKINGS - HOT_BOOKINGS, TRAVELERS, HOT_BOOKINGS]
  );
  hot[tenantId] = (await q("SELECT id FROM svc WHERE rn = 1")).rows[0].id;
  await q("DROP TABLE svc, trav");

  const sample = await q(
    `SELECT m.id AS mid, m."userId" AS uid, u.email, m."providerOrganizationId" AS org,
       CASE WHEN u.email LIKE 'admin-%' THEN 'tenant-admin' WHEN u.email LIKE 'prov-%' THEN 'service-provider' ELSE 'traveler' END AS role
     FROM tenant_memberships m JOIN users u ON u.id=m."userId" WHERE m."tenantId"=$1
     ORDER BY (u.email LIKE 'admin-%') DESC, (u.email LIKE 'prov-%') DESC, u.email LIMIT $2`,
    [tenantId, TOKENS_PER_TENANT]
  );
  const now = Math.floor(Date.now() / 1000);
  for (const row of sample.rows) {
    const sid = randomUUID();
    await q(
      `INSERT INTO refresh_sessions (id,"tokenHash","userId","tenantId","membershipId","expiresAt","lastUsedAt","familyId","authenticatedAt")
       VALUES ($1::uuid, encode(sha256(convert_to($1::uuid::text,'UTF8')),'hex'), $2,$3,$4, now() + interval '1 day', now(), gen_random_uuid(), now())`,
      [sid, row.uid, tenantId, row.mid]
    );
    tokens.push({
      role: row.role, tenantId, tenantCode: code, membershipId: row.mid, organizationId: row.org,
      token: sign({ iss: "safry-api", aud: "safry-access", av: 0, sid, sub: row.uid, tid: tenantId, mid: row.mid, email: row.email, roles: [row.role], permissions: [], iat: now, exp: now + 6 * 3600 })
    });
  }
}
mkdirSync(new URL("./.data/", import.meta.url), { recursive: true });
writeFileSync(new URL("./.data/tokens.json", import.meta.url), JSON.stringify({ tokens, hot, createdAt: new Date().toISOString() }));
await q("ANALYZE");
const counts = await q(
  `SELECT (SELECT count(*) FROM users)::int users, (SELECT count(*) FROM bookings)::int bookings,
          (SELECT count(*) FROM travel_services)::int services, (SELECT count(*) FROM refresh_sessions)::int sessions`
);
console.log(JSON.stringify({ ...counts.rows[0], tokens: tokens.length, seconds: (Date.now() - t0) / 1000 }));
await client.end();
