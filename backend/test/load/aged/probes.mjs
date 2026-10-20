// Failure probes on the aged database. The API must run with the SHIPPED limits (bash measure-env.sh <run> safry defaults).
//   node probes.mjs --run a --db safry [--only lockout,ratelimit,overload,restart,backup]
import { execFileSync } from "node:child_process";
import { parseArgs, loadRunEnv, loadJson, saveJson, call, docker, sleep, round, stats } from "./common.mjs";
import { World } from "./world.mjs";
import { startTraffic, summarize } from "./traffic.mjs";

const args = parseArgs();
const run = loadRunEnv(args.run ?? "a");
const dbName = args.db ?? "safry";
const only = args.only ? String(args.only).split(",") : ["lockout", "ratelimit", "overload", "restart", "backup"];
const actors = loadJson(`${run.run}-${dbName}-actors.json`);
const w = await new World(run, actors, dbName).init();
w.mfaSecret = actors.platformMfaSecret;
const A = actors;
const base = run.base;
const result = {};
const login = (email, password, ip) => call(base, "POST", "/auth/login", { body: { email, password, tenantCode: A.tenantCode }, ip });
const seq = (rs) => rs.map((r) => r.status).join(" ");

if (only.includes("lockout")) {
  const out = {};
  const one = A.travelers[33].email, many = A.travelers[32].email;
  // (a) one address, one account: wrong passwords until it blocks
  const ip = "198.18.7.7";
  const rs = [];
  for (let i = 0; i < 8; i++) rs.push(await login(one, "Wrong-password-1", ip));
  out.sameAddressWrongPasswords = { statuses: seq(rs), retryAfter: rs.filter((r) => r.status === 429).map((r) => r.headers["retry-after"])[0] ?? null, firstBlockedAtAttempt: rs.findIndex((r) => r.status === 429) + 1 || null };
  const rightBlocked = await login(one, A.password, ip);
  const rightOther = await login(one, A.password, "198.18.7.8");
  out.afterBlock = { rightPasswordSameAddress: rightBlocked.status, rightPasswordOtherAddress: rightOther.status };
  // (b) distributed: a known good address first, then wrong passwords from many addresses
  const trusted = "198.18.9.9";
  const okFirst = await login(many, A.password, trusted);
  const flood = [];
  for (let i = 0; i < 30; i++) flood.push(await login(many, "Wrong-password-1", `198.18.10.${i + 1}`));
  const trustedAfter = await login(many, A.password, trusted);
  const freshAfter = await login(many, A.password, "198.18.11.1");
  out.distributedFlood = { firstLoginTrustedAddress: okFirst.status, floodStatuses: seq(flood), trustedAddressAfterFlood: trustedAfter.status, newAddressAfterFlood: freshAfter.status, firstBlockedAt: flood.findIndex((r) => r.status === 429) + 1 || null };
  // (c) platform admin unlock
  const pt = (await w.actor("platform")).token;
  const unlock = await call(base, "POST", "/auth/login-throttle/unlock", { token: pt, body: { email: many } });
  const unlockOne = await call(base, "POST", "/auth/login-throttle/unlock", { token: pt, body: { email: one } });
  const afterUnlock = await login(many, A.password, "198.18.11.2");
  out.unlock = { statusMany: unlock.status, statusOne: unlockOne.status, newAddressAfterUnlock: afterUnlock.status };
  result.lockout = out;
  console.log("lockout", JSON.stringify(out));
}

if (only.includes("ratelimit")) {
  const t = (await w.actor("traveler", 5)).token;
  const ip = "198.18.20.20";
  const rs = [];
  for (let i = 0; i < 340; i++) rs.push(await call(base, "GET", "/services/marketplace?limit=1", { token: t, ip }));
  const first429 = rs.findIndex((r) => r.status === 429);
  const hdr = rs[first429]?.headers ?? {};
  // user-keyed limit: same user from many addresses
  const rs2 = [];
  for (let i = 0; i < 650; i++) rs2.push(await call(base, "GET", "/auth/me", { token: t, ip: `198.18.21.${(i % 250) + 1}` }));
  const first429b = rs2.findIndex((r) => r.status === 429);
  const recoverStart = Date.now();
  let recovered = null;
  while (Date.now() - recoverStart < 70_000) { const r = await call(base, "GET", "/services/marketplace?limit=1", { token: t, ip }); if (r.status === 200) { recovered = round((Date.now() - recoverStart) / 1000, 1); break; } await sleep(2000); }
  result.ratelimit = { singleAddress: { requests: rs.length, status200: rs.filter((r) => r.status === 200).length, status429: rs.filter((r) => r.status === 429).length, firstBlockedAtRequest: first429 + 1 || null, retryAfter: hdr["retry-after"] ?? null }, singleUserManyAddresses: { requests: rs2.length, status429: rs2.filter((r) => r.status === 429).length, firstBlockedAtRequest: first429b + 1 || null }, secondsUntilAllowedAgain: recovered };
  console.log("ratelimit", JSON.stringify(result.ratelimit));
}

if (only.includes("overload")) {
  const N = Number(args.burst ?? 300);
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => call(base, "POST", "/auth/login", { body: { email: A.travelers[i % 30].email, password: A.password, tenantCode: A.tenantCode } })));
  const wall = Date.now() - t0;
  const byStatus = {};
  for (const r of rs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const s503 = rs.find((r) => r.status === 503);
  const okMs = stats(rs.filter((r) => r.status === 200).map((r) => r.ms));
  const ready = await call(base, "GET", "/health/ready", {});
  await sleep(5000);
  const after = await call(base, "GET", "/health/ready", {});
  const me = await call(base, "GET", "/services/marketplace?limit=1", { token: (await w.actor("traveler", 3)).token });
  result.overload = { burst: N, wallMs: wall, byStatus, retryAfterOn503: s503?.headers["retry-after"] ?? null, bodyOn503: s503 ? JSON.stringify(s503.body).slice(0, 160) : null, okLoginP50: round(okMs.p50), okLoginP95: round(okMs.p95), okLoginMax: round(okMs.max), readyDuringTail: ready.status, readyAfter5s: after.status, ordinaryRequestAfter: me.status };
  console.log("overload", JSON.stringify(result.overload));
}

if (only.includes("restart")) {
  const out = {};
  for (const mode of ["graceful (docker restart, SIGTERM)", "crash (docker kill, SIGKILL)"]) {
    const st = { bookable: (await call(base, "GET", "/services?limit=50", { token: (await w.actor("provider")).token })).body.filter((s) => s.status === "ACTIVE").slice(0, 8).map((s) => s.id) };
    const traffic = startTraffic(w, st, { rate: 20 });
    await sleep(15_000);
    const kill = Date.now();
    if (mode.startsWith("graceful")) docker("restart", "-t", "30", run.apiContainer); else { docker("kill", run.apiContainer); docker("start", run.apiContainer); }
    const restarted = Date.now();
    let readyAt = null;
    while (Date.now() - restarted < 120_000) { const r = await call(base, "GET", "/health/ready", {}); if (r.status === 200) { readyAt = Date.now(); break; } await sleep(250); }
    await sleep(20_000);
    traffic.stop();
    await sleep(1500);
    const during = traffic.samples.filter((s) => s.t >= kill && s.t < (readyAt ?? Date.now()));
    const before = summarize(traffic.samples, kill - 15_000, kill).all;
    const afterS = summarize(traffic.samples, readyAt ?? kill, readyAt ? readyAt + 20_000 : kill + 20_000).all;
    // sessions must survive: a fresh request with an OLD token (issued before the restart)
    const old = await call(base, "GET", "/auth/me", { token: (await w.actor("traveler", 7)).token });
    out[mode] = { dockerRestartCommandSeconds: round((restarted - kill) / 1000, 1), secondsFromCommandToReady: readyAt ? round((readyAt - kill) / 1000, 1) : null, requestsDuringOutage: during.length, failedDuringOutage: during.filter((s) => !s.ok).length, statusCountsDuringOutage: Object.fromEntries([...new Set(during.map((s) => s.status))].map((k) => [k, during.filter((s) => s.status === k).length])), beforeP95: before.p95, afterP95: afterS.p95, afterErrors: afterS.n - afterS.ok, tokenIssuedBeforeRestartStillValid: old.status === 200 };
    console.log("restart", mode, JSON.stringify(out[mode]));
    await sleep(5000);
  }
  result.restart = out;
}

if (only.includes("backup")) {
  const pg = run.pgContainer;
  const exec = (...a) => docker("exec", "-e", `PGPASSWORD=${run.OWNER_PW}`, pg, ...a);
  const out = {};
  let s = Date.now();
  exec("pg_dump", "-U", "safry", "-Fc", "-f", "/tmp/aged.dump", dbName);
  out.pgDumpCustomSeconds = round((Date.now() - s) / 1000, 1);
  out.dumpBytes = Number(exec("sh", "-c", "stat -c %s /tmp/aged.dump"));
  s = Date.now();
  exec("sh", "-c", "pg_dump -U safry -Fp safry | gzip -c > /tmp/aged.sql.gz");
  out.pgDumpPlainGzipSeconds = round((Date.now() - s) / 1000, 1);
  out.plainGzipBytes = Number(exec("sh", "-c", "stat -c %s /tmp/aged.sql.gz"));
  exec("psql", "-U", "safry", "-d", "postgres", "-c", "DROP DATABASE IF EXISTS safry_restore");
  exec("psql", "-U", "safry", "-d", "postgres", "-c", "CREATE DATABASE safry_restore");
  s = Date.now();
  exec("pg_restore", "-U", "safry", "-d", "safry_restore", "-j", "2", "--no-owner", "/tmp/aged.dump");
  out.pgRestoreSeconds = round((Date.now() - s) / 1000, 1);
  const count = (db, table) => Number(exec("psql", "-U", "safry", "-d", db, "-Atc", `SELECT count(*) FROM ${table}`));
  out.rowCountsMatch = Object.fromEntries(["users", "bookings", "refresh_sessions", "audit_events"].map((t) => [t, { source: count(dbName, t), restored: count("safry_restore", t) }]));
  out.restoredDbBytes = Number(exec("psql", "-U", "safry", "-d", "postgres", "-Atc", "SELECT pg_database_size('safry_restore')"));
  exec("psql", "-U", "safry", "-d", "postgres", "-c", "DROP DATABASE safry_restore");
  exec("rm", "-f", "/tmp/aged.dump", "/tmp/aged.sql.gz");
  result.backup = out;
  console.log("backup", JSON.stringify(out));
}

saveJson(`probes-${run.run}.json`, result);
await w.close();
process.exit(0);
