// Simulated user-days against the REAL API: what one active user costs in rows and bytes per day.
//   node growth.mjs --run a --db safry --users 100 --days 3 --refreshes 32 --concurrency 4
// One simulated day of one user = login, profile/catalogue reads, K token refreshes (+1 activity ping each), 2 bookings (create),
// 1 edit, 1 confirmation by the provider, 1 cancellation, 2 failed logins, 1 forgot-password request, logout.
// Day 1 of a new user also registers (real endpoint) and verifies the e-mail with the link read from the API log (console mail transport).
import { parseArgs, loadRunEnv, loadJson, saveJson, call, ownerClient, round } from "./common.mjs";
import { World, linksByEmail, tokenOf } from "./world.mjs";
import { snapshot, walBytes, mib } from "./dbstats.mjs";

const args = parseArgs();
const run = loadRunEnv(args.run ?? "a");
const dbName = args.db ?? "safry";
const U = Number(args.users ?? 100), D = Number(args.days ?? 3), K = Number(args.refreshes ?? 32), CONC = Number(args.concurrency ?? 4);
const actors = loadJson(`${run.run}-${dbName}-actors.json`);
const w = await new World(run, actors, dbName).init();
const base = run.base;
const stamp = Math.random().toString(36).slice(2, 7);
const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const before = await snapshot(w.sql);
const startedAt = new Date();
const t0 = Date.now();
const prov = await w.actor("provider");
const own = (await call(base, "GET", "/services?limit=50", { token: prov.token })).body.filter((s) => s.status === "ACTIVE").slice(0, 8).map((s) => s.id);
const counts = { calls: 0, errors: {}, byRoute: {} };
const count = (route, r, ok) => {
  counts.calls += 1;
  const b = (counts.byRoute[route] ??= { calls: 0, ok: 0, ms: 0 });
  b.calls += 1; b.ms += r.ms;
  if (ok.includes(r.status)) b.ok += 1; else counts.errors[`${route} ${r.status}`] = (counts.errors[`${route} ${r.status}`] ?? 0) + 1;
  return r;
};
const C = (route, method, path, opts, ok = [200]) => call(base, method, path, opts).then((r) => count(route, r, ok));

// ---- day 1 setup: register all users (real endpoint), then read the verification links ONCE from the log, verify, ready
const users = Array.from({ length: U }, (_, u) => ({ email: `growth-${stamp}-${u}@example.test`, password: `Growth-${stamp}-pw-${u}-x`, u }));
await Promise.all(Array.from({ length: CONC }, async (_, k) => {
  for (let i = k; i < U; i += CONC) {
    const x = users[i];
    await C("POST /auth/register/customer", "POST", "/auth/register/customer", { body: { displayName: `Growth ${i}`, email: x.email, password: x.password, tenantCode: actors.tenantCode } }, [200, 201, 202]);
  }
}));
await new Promise((r) => setTimeout(r, 1500));
const links = linksByEmail(run.apiContainer, "60m");
let viaSql = 0;
await Promise.all(Array.from({ length: CONC }, async (_, k) => {
  for (let i = k; i < U; i += CONC) {
    const x = users[i];
    const token = tokenOf(links.get(x.email));
    if (token) await C("POST /auth/email/verify", "POST", "/auth/email/verify", { body: { token } }, [200, 204]);
    else { viaSql += 1; await w.sql.query('UPDATE users SET "emailVerifiedAt" = now() WHERE "emailNormalized" = $1', [x.email]); }
  }
}));

async function userDay(x, day) {
  const login = await C("POST /auth/login", "POST", "/auth/login", { body: { email: x.email, password: x.password, tenantCode: actors.tenantCode } });
  if (login.status !== 200) throw new Error(`login ${login.status} ${JSON.stringify(login.body).slice(0, 120)}`);
  let access = login.body.accessToken, refresh = login.body.refreshToken;
  await C("GET /users/me", "GET", "/users/me", { token: access });
  await C("GET /auth/me", "GET", "/auth/me", { token: access });
  await C("GET /services/marketplace", "GET", "/services/marketplace?limit=20", { token: access });
  const book = [];
  for (let k = 0; k < K; k++) {
    const r = await C("POST /auth/refresh", "POST", "/auth/refresh", { body: { refreshToken: refresh } });
    if (r.status !== 200) throw new Error(`refresh ${r.status}`);
    access = r.body.accessToken; refresh = r.body.refreshToken;
    await C("POST /auth/activity", "POST", "/auth/activity", { token: access }, [204]);
    if (k % 8 === 0) await C("GET /bookings", "GET", "/bookings?limit=20", { token: access });
    if (k === 4 || k === 5) {
      const b = await C("POST /bookings", "POST", "/bookings", { token: access, body: { serviceId: own[(x.u + k) % own.length], travelersCount: 2, serviceDate: days(10 + ((x.u * 7 + day * 3 + k) % 300)) } }, [201]);
      if (b.status === 201) book.push(b.body.id);
    }
  }
  if (book[0]) {
    await C("PATCH /bookings/:id", "PATCH", `/bookings/${book[0]}`, { token: access, body: { travelersCount: 3 } });
    const pt = (await w.actor("provider")).token;
    await C("PATCH /bookings/:id/status", "PATCH", `/bookings/${book[0]}/status`, { token: pt, body: { status: "CONFIRMED" } });
  }
  if (book[1]) await C("PATCH /bookings/:id/status", "PATCH", `/bookings/${book[1]}/status`, { token: access, body: { status: "CANCELLED" } });
  for (let f = 0; f < 2; f++) await C("POST /auth/login", "POST", "/auth/login", { body: { email: x.email, password: "Wrong-password-1", tenantCode: actors.tenantCode } }, [401]);
  await C("POST /auth/password/forgot", "POST", "/auth/password/forgot", { body: { email: x.email } }, [202]);
  await C("POST /auth/logout", "POST", "/auth/logout", { body: { refreshToken: refresh } }, [204]);
}

let failed = 0;
const afterReg = await snapshot(w.sql);
const auditAt = async (since) => Object.fromEntries((await w.sql.query(`SELECT action, count(*)::int AS n FROM audit_events WHERE "occurredAt" >= $1 GROUP BY action`, [since])).rows.map((r) => [r.action, r.n]));
const regAudit = await auditAt(startedAt);
const dayStart = new Date();
for (let day = 1; day <= D; day++) {
  await Promise.all(Array.from({ length: CONC }, async (_, k) => {
    for (let i = k; i < U; i += CONC) {
      try { await userDay(users[i], day); } catch (e) { failed += 1; counts.errors[`userDay: ${String(e.message).slice(0, 60)}`] = (counts.errors[`userDay: ${String(e.message).slice(0, 60)}`] ?? 0) + 1; }
    }
  }));
  console.log(`simulated day ${day}/${D} done, ${round((Date.now() - t0) / 1000)} s`);
}
const daysAudit = await auditAt(dayStart);
const wallS = (Date.now() - t0) / 1000;
const after = await snapshot(w.sql);
const userDays = U * D - failed;

// one-time cost per new user (register + verify) and steady cost per active user-day
const phase = (a, b, divisor) => {
  const t = {};
  for (const [name, x] of Object.entries(b.tables)) {
    const y = a.tables[name] ?? { rows: 0, total: 0, dead: 0, upd: 0, hotUpd: 0 };
    const dRows = x.rows - y.rows, dBytes = x.total - y.total;
    if (dRows !== 0 || dBytes > 0) t[name] = { rowsAdded: dRows, bytesAdded: dBytes, rowsPerUnit: round(dRows / divisor, 3), bytesPerUnit: Math.round(dBytes / divisor), bytesPerRow: dRows > 0 ? Math.round(dBytes / dRows) : null, deadAfter: x.dead, updatesPerUnit: round((x.upd - y.upd) / divisor, 2), hotUpdatesPerUnit: round((x.hotUpd - y.hotUpd) / divisor, 2) };
  }
  return t;
};
const perNewUser = phase(before, afterReg, U);
const perUserDay = phase(afterReg, after, userDays);
const auditPer = (map, div) => Object.entries(map).sort((a, b) => b[1] - a[1]).map(([action, n]) => ({ action, rows: n, perUnit: round(n / div, 3) }));
const wal = await walBytes(w.sql, afterReg.lsn, after.lsn);
const out = {
  run: run.run, db: dbName, at: new Date().toISOString(), users: U, days: D, refreshesPerDay: K, concurrency: CONC, failedUserDays: failed, userDays, verifiedViaSql: viaSql, wallS: round(wallS), apiCalls: counts.calls,
  perUserDay: { totalDbBytes: Math.round((after.dbBytes - afterReg.dbBytes) / userDays), walBytes: Math.round(wal / userDays), tables: perUserDay, auditByAction: auditPer(daysAudit, userDays) },
  perNewUser: { totalDbBytes: Math.round((afterReg.dbBytes - before.dbBytes) / U), tables: perNewUser, auditByAction: auditPer(regAudit, U) },
  dbBytesBefore: before.dbBytes, dbBytesAfter: after.dbBytes,
  errors: counts.errors, byRoute: Object.fromEntries(Object.entries(counts.byRoute).map(([k, v]) => [k, { calls: v.calls, ok: v.ok, meanMs: round(v.ms / v.calls) }]))
};
saveJson(`growth-${run.run}-${dbName}.json`, out);
console.log(JSON.stringify({ userDays, wallS: out.wallS, perUserDayBytes: out.perUserDay.totalDbBytes, perNewUserBytes: out.perNewUser.totalDbBytes, walBytesPerUserDay: out.perUserDay.walBytes, tables: Object.fromEntries(Object.entries(perUserDay).map(([k, v]) => [k, `${v.rowsPerUnit} rows, ${v.bytesPerUnit} B / user-day`])), audit: out.perUserDay.auditByAction, errors: counts.errors }, null, 1));
await w.close();
