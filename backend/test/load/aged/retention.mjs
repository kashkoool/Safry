// Retention on the aged (and soaked) database, under live traffic: the repo's own purge script (pnpm db:purge-local) is run while the API
// serves a normal request mix; latency in 10-second windows before, during and after is reported with lock waits, rows removed,
// sizes, dead tuples, autovacuum effect, plain VACUUM and VACUUM FULL.
//   node retention.mjs --run a --db safry --backend <dir of the run's backend checkout> --rate 20
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs, loadRunEnv, loadJson, saveJson, call, sleep, round, HERE } from "./common.mjs";
import { World } from "./world.mjs";
import { snapshot, mib } from "./dbstats.mjs";
import { startTraffic, summarize, prewarm } from "./traffic.mjs";

const args = parseArgs();
const run = loadRunEnv(args.run ?? "a");
const dbName = args.db ?? "safry";
const rate = Number(args.rate ?? 20);
const backend = resolve(args.backend ?? resolve(HERE, "../../.."));
const actors = loadJson(`${run.run}-${dbName}-actors.json`);
const w = await new World(run, actors, dbName).init();
w.mfaSecret = actors.platformMfaSecret;
const prov = await w.actor("provider");
const own = (await call(run.base, "GET", "/services?limit=50", { token: prov.token })).body;
const st = { bookable: own.filter((s) => s.status === "ACTIVE").slice(0, 8).map((s) => s.id) };
const phases = {};
const snaps = {};
snaps.before = await snapshot(w.sql);

await prewarm(w, st);
const traffic = startTraffic(w, st, { rate });
let lockWaitMax = 0, lockSamples = 0, sampling = true;
void (async () => {
  while (sampling) {
    const r = await w.sql.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND usename = 'safry_runtime'`);
    lockWaitMax = Math.max(lockWaitMax, r.rows[0].n); lockSamples += 1;
    await sleep(250);
  }
})();
const lockedAtEnd = [];
await sleep(Number(args.baselineS ?? 60) * 1000);
phases.purgeStart = Date.now();
const out = [];
const code = await new Promise((resolveExit) => {
  const child = spawn(process.execPath, [resolve(backend, "node_modules/tsx/dist/cli.mjs"), "scripts/db/run-purge.ts", "--url", run.ownerUrl(dbName)], { cwd: backend, env: { ...process.env, TZ: "UTC", PGTZ: "UTC" } });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  child.on("close", resolveExit);
});
phases.purgeEnd = Date.now();
console.log(out.join(""));
await sleep(Number(args.afterS ?? 60) * 1000);
phases.trafficEnd = Date.now();
traffic.stop();
sampling = false;
await sleep(1000);

const windows = [];
for (let t = traffic.samples[0].t; t < phases.trafficEnd; t += 10_000) {
  const s = summarize(traffic.samples, t, t + 10_000);
  const phase = t + 10_000 <= phases.purgeStart ? "before" : t >= phases.purgeEnd ? "after" : "during";
  windows.push({ phase, atS: Math.round((t - traffic.samples[0].t) / 1000), n: s.all.n, p50: s.all.p50, p95: s.all.p95, p99: s.all.p99, max: s.all.max, s5xx: s.all.s5xx, s429: s.all.s429, neterr: s.all.neterr });
}
const phaseSummary = {};
for (const ph of ["before", "during", "after"]) {
  const lo = ph === "before" ? 0 : ph === "during" ? phases.purgeStart : phases.purgeEnd, hi = ph === "before" ? phases.purgeStart : ph === "during" ? phases.purgeEnd : phases.trafficEnd;
  const s = summarize(traffic.samples, lo, hi);
  phaseSummary[ph] = { seconds: round((hi - lo) / 1000), ...s.all };
}
snaps.afterPurge = await snapshot(w.sql);
console.log("waiting 3 minutes idle to observe autovacuum ...");
await sleep(Number(args.idleS ?? 180) * 1000);
snaps.afterIdle3min = await snapshot(w.sql);
const t1 = Date.now();
for (const t of ["refresh_sessions", "credential_tokens", "login_throttles", "bookings", "audit_events"]) await w.sql.query(`VACUUM (ANALYZE) "${t}"`);
const vacuumMs = Date.now() - t1;
snaps.afterVacuum = await snapshot(w.sql);
const t2 = Date.now();
const full = {};
for (const t of ["refresh_sessions", "credential_tokens"]) { const s = Date.now(); await w.sql.query(`VACUUM FULL "${t}"`); full[t] = Date.now() - s; }
const vacuumFullMs = Date.now() - t2;
snaps.afterVacuumFull = await snapshot(w.sql);

const cmp = {};
for (const name of Object.keys(snaps.before.tables)) {
  cmp[name] = Object.fromEntries(Object.entries(snaps).map(([k, s]) => [k, s.tables[name] ? { rows: s.tables[name].rows, MiB: mib(s.tables[name].total), dead: s.tables[name].dead, autovacuumCount: s.tables[name].autovacuumCount } : null]));
}
const result = { run: run.run, db: dbName, rate, purgeExitCode: code, purgeSeconds: round((phases.purgeEnd - phases.purgeStart) / 1000), purgeOutput: out.join("").split("\n").filter(Boolean), phaseSummary, windows, lockWaitMaxSessions: lockWaitMax, lockSamples, dbMiB: Object.fromEntries(Object.entries(snaps).map(([k, s]) => [k, mib(s.dbBytes)])), tables: cmp, vacuumMs, vacuumFullMs, vacuumFullByTable: full, dropped: traffic.dropped };
saveJson(`retention-${run.run}.json`, result);
console.log(JSON.stringify({ purgeSeconds: result.purgeSeconds, phaseSummary, lockWaitMaxSessions: lockWaitMax, dbMiB: result.dbMiB, vacuumMs, vacuumFullMs }, null, 1));
await w.close();
process.exit(0);
