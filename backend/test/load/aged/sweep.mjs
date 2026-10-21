// Endpoint sweep: every route of the API as the right actor, >= 200 calls each (serial), p50/p95/p99 per case.
//   node sweep.mjs --run a --db safry [--smoke] [--only text] [--n 200]
// Needs: API running against that database (infra.sh), actors.mjs run for it.
import { parseArgs, loadRunEnv, loadJson, saveJson, call, stats, round, sleep } from "./common.mjs";
import { World } from "./world.mjs";
import { buildCases } from "./cases.mjs";

const args = parseArgs();
const run = loadRunEnv(args.run ?? "a");
const dbName = args.db ?? "safry";
const actorsFile = `${run.run}-${dbName}-actors.json`;
const actors = loadJson(actorsFile);
const w = await new World(run, actors, dbName).init();
await w.enrollPlatformMfa();
saveJson(actorsFile, actors);
const smoke = Boolean(args.smoke);
const n = args.n ? Number(args.n) : null;

// The password-change case alternates the password of one account: restore the known one before every run.
{
  const { hashPassword } = await import(new URL("../../../dist/common/security/password.js", import.meta.url).href);
  await w.sql.query('UPDATE users SET "passwordHash" = $2 WHERE "emailNormalized" = $1', [actors.travelers[39].email, await hashPassword(actors.password)]);
}
// ------------------------------------------------------------------ discovery (untimed)
const st = { sweepRoles: [], sweepServices: [], sweepProviders: [], departments: [], orgRoles: [], employees: [], sweepTenants: [], platformUsers: [], cursors: { bookings: {} } };
const admin = await w.actor("admin");
const prov = await w.actor("provider");
const trav = await w.actor("traveler", 0);
const get = async (s, path) => { const r = await call(run.base, "GET", path, { token: s.token }); if (r.status !== 200) throw new Error(`${path} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r; };
{
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
}

// ------------------------------------------------------------------ run
const cases = buildCases(w, st);
const results = [];
const cycle = new Set(cases.cycles ?? []);
for (const c of cases) {
  if (args.only && !`${c.route} ${c.name}`.toLowerCase().includes(String(args.only).toLowerCase())) continue;
  const count = smoke ? Math.min(3, c.n) : n ? Math.min(n, c.n) : c.n;
  if (smoke && c.name.includes("cold")) continue;
  const ok = [], all = [], bad = {};
  let sample = null, setupErrors = 0;
  const wall = Date.now();
  if (c.custom) {
    // multi-step case: every timed step is recorded under its own label
    const buckets = new Map();
    const timed = async (label, routeName, method, path, opts, expect) => {
      const r = await call(run.base, method, path, opts);
      const b = buckets.get(label) ?? { route: routeName, ok: [], bad: {}, sample: null };
      if (expect.includes(r.status)) b.ok.push(r.ms);
      else { b.bad[r.status] = (b.bad[r.status] ?? 0) + 1; b.sample ??= `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`; }
      buckets.set(label, b);
      return r;
    };
    for (let i = 0; i < count; i++) {
      try { await c.custom(i, timed); } catch (e) { setupErrors += 1; sample ??= `setup: ${String(e.message).slice(0, 200)}`; }
    }
    for (const [label, b] of buckets) {
      const s = stats(b.ok);
      const row = { route: b.route, name: label, actor: "custom", calls: count, ok: b.ok.length, bad: b.bad, setupErrors, p50: round(s.p50), p95: round(s.p95), p99: round(s.p99), max: round(s.max), mean: round(s.mean), wallS: round((Date.now() - wall) / 1000), sample: b.sample ?? sample };
      results.push(row);
      console.log(`${b.route.padEnd(58)} ${label.padEnd(42)} n=${String(count).padStart(3)} ok=${String(b.ok.length).padStart(3)} p50=${String(row.p50).padStart(7)} p95=${String(row.p95).padStart(7)} p99=${String(row.p99).padStart(7)}${b.ok.length < count ? `  <-- PROBLEM [${row.sample}]` : ""}`);
    }
    continue;
  }
  for (let i = 0; i < count; i++) {
    let prepared;
    try {
      if (c.prep) prepared = await c.prep(i);
      const r0 = c.req(i, prepared);
      let token = r0.token;
      if (!token && !c.anon) token = (await w.actor(c.actor, i)).token;
      let r = await call(run.base, r0.method, r0.path, { token, body: r0.body, headers: r0.headers });
      if (r.status === 401 && !c.anon && !r0.token) { w.sessions.clear(); token = (await w.actor(c.actor, i)).token; r = await call(run.base, r0.method, r0.path, { token, body: r0.body, headers: r0.headers }); }
      all.push(r.ms);
      if (c.expect.includes(r.status)) ok.push(r.ms);
      else { bad[r.status] = (bad[r.status] ?? 0) + 1; sample ??= `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`; }
      if (c.after) await c.after(r, i, prepared);
    } catch (e) {
      setupErrors += 1;
      sample ??= `setup: ${String(e.message).slice(0, 200)}`;
    }
  }
  const s = stats(ok);
  const row = { route: c.route, name: c.name, actor: c.anon ? "anonymous" : c.actor ?? "custom", calls: count, ok: ok.length, bad, setupErrors, p50: round(s.p50), p95: round(s.p95), p99: round(s.p99), max: round(s.max), mean: round(s.mean), wallS: round((Date.now() - wall) / 1000), sample };
  results.push(row);
  const flag = ok.length < count ? "  <-- PROBLEM" : "";
  console.log(`${c.route.padEnd(58)} ${c.name.padEnd(42)} n=${String(count).padStart(3)} ok=${String(ok.length).padStart(3)} p50=${String(row.p50).padStart(7)} p95=${String(row.p95).padStart(7)} p99=${String(row.p99).padStart(7)}${flag}${sample && ok.length < count ? `  [${sample}]` : ""}`);
}
if (!smoke && !args.only) saveJson(`sweep-${run.run}-${dbName}.json`, { run: run.run, db: dbName, at: new Date().toISOString(), apiRoutes: new Set(results.map((r) => r.route)).size, bookingPages: st.bookingPages, results });
await w.close();
