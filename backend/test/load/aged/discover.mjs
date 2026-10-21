// Fixture discovery for the sweep cases (untimed): ids the cases need, read through the API or from the owner connection.
import { call } from "./common.mjs";

export async function discover(w) {
  const { run, actors } = w;
  const st = { sweepRoles: [], sweepServices: [], sweepProviders: [], departments: [], orgRoles: [], employees: [], sweepTenants: [], platformUsers: [], cursors: { bookings: {} } };
  const admin = await w.actor("admin");
  const prov = await w.actor("provider");
  const get = async (s, path) => { const r = await call(run.base, "GET", path, { token: s.token }); if (r.status !== 200) throw new Error(`${path} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r; };
  const own = (await get(prov, "/services?limit=50")).body;
  st.ownServices = own.map((s) => s.id);
  // bookings are made on the provider's own active services, so the provider can also confirm them
  st.bookableServices = own.filter((s) => s.status === "ACTIVE").slice(0, 8).map((s) => s.id);
  const roles = (await get(admin, "/roles")).body;
  st.roleIds = Object.fromEntries(roles.map((r) => [r.code, r.id]));
  const emails = new Set([...actors.travelers.map((t) => t.email), actors.admin.email, actors.provider.email, actors.orgmgr.email]);
  const spare = await w.sql.query(
    `SELECT m.id AS "membershipId", u.id AS "userId", u."emailNormalized" AS email FROM tenant_memberships m JOIN users u ON u.id = m."userId"
      WHERE m."tenantId" = $1 AND m.status = 'ACTIVE' AND u.status = 'ACTIVE' AND (u."emailNormalized" LIKE 'user%' OR u."emailNormalized" LIKE 'fresh-spare-%') AND u."deletedAt" IS NULL AND m."providerOrganizationId" IS NULL
      ORDER BY u."createdAt" DESC LIMIT 60`, [actors.tenantId]);
  st.spareMembers = spare.rows.filter((r) => !emails.has(r.email)).slice(0, 5);
  const heavy = await w.sql.query('SELECT m.id FROM tenant_memberships m JOIN users u ON u.id = m."userId" WHERE m."tenantId" = $1 AND u."emailNormalized" = ANY($2)', [actors.tenantId, actors.travelers.slice(0, 10).map((t) => t.email)]);
  st.heavyMemberships = heavy.rows.map((r) => r.id);
  // an invitation tenant: invited memberships for two actors (membership rows reset before every accept/decline)
  const inv = (await w.sql.query('INSERT INTO tenants (id, code, name, "updatedAt") VALUES (gen_random_uuid(), $1, $2, now()) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id', ["sweep-invite", "Sweep invitations"])).rows[0].id;
  st.invitations = [];
  for (const t of [actors.travelers[30], actors.travelers[31]]) {
    const u = (await w.sql.query('SELECT id FROM users WHERE "emailNormalized" = $1', [t.email])).rows[0].id;
    const m = await w.sql.query(`INSERT INTO tenant_memberships (id, "tenantId", "userId", status, "awaitingOwnerConsent", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'INVITED', true, now())
       ON CONFLICT ("tenantId", "userId") DO UPDATE SET status = 'INVITED' RETURNING id`, [inv, u]);
    st.invitations.push({ email: t.email, membershipId: m.rows[0].id });
  }
  // booking cursors for the deep-paging cases
  let cursor = null, page = 0;
  for (;;) {
    const r = await call(run.base, "GET", `/bookings?limit=100${cursor ? `&cursor=${cursor}` : ""}`, { token: admin.token });
    page += 1;
    const next = r.headers["x-next-cursor"];
    if (page === 10 && next) st.cursors.bookings[10] = next;
    if (page === 50 && next) st.cursors.bookings[50] = next;
    if (!next) break;
    st.cursors.bookings.max = next;
    cursor = next;
  }
  st.cursors.bookings[10] ??= st.cursors.bookings.max;
  st.cursors.bookings[50] ??= st.cursors.bookings.max;
  st.bookingPages = page;
  return st;
}
