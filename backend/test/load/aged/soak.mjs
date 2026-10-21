// Soak on the aged database: mixed steady load, sampled every window (default 30 s).
//   node soak.mjs --run a --db safry --minutes 45 --rate 30 [--window 30] [--label x]
// Samples per window: API RSS/heap (/metrics), API+DB container CPU and memory (docker stats), a 1 Hz /health/live canary (event-loop and
// queueing proxy), DB connections of the runtime login, database size and per-table size/dead tuples/autovacuum counters,
// API log lines and bytes, error/warn log lines, and p50/p95/p99 and error counts per endpoint.
import { execFileSync } from "node:child_process";
import { parseArgs, loadRunEnv, loadJson, saveJson, call, ownerClient, docker, dockerStats, scrapeMetrics, sleep, round, stats } from "./common.mjs";
import { World } from "./world.mjs";
import { snapshot } from "./dbstats.mjs";
import { startTraffic, summarize, prewarm } from "./traffic.mjs";

const args = parseArgs();
const run = loadRunEnv(args.run ?? "a");
const dbName = args.db ?? "safry";
const minutes = Number(args.minutes ?? 45), rate = Number(args.rate ?? 30), windowS = Number(args.window ?? 30);
const label = args.label ?? "soak";
const actors = loadJson(`${run.run}-${dbName}-actors.json`);
const w = await new World(run, actors, dbName).init();
w.mfaSecret = actors.platformMfaSecret;
const prov = await w.actor("provider");
const own = (await call(run.base, "GET", "/services?limit=50", { token: prov.token })).body;
const st = { bookable: own.filter((s) => s.status === "ACTIVE").slice(0, 8).map((s) => s.id) };

const poolMax = 10;
await prewarm(w, st);
// Sessions are renewed in the background, one actor every 15 s, so traffic never has to sign in (a burst of 40 sign-ins stalls a 1-CPU API).
w.maxAgeMs = 1e12;
const renew = [...Array.from({ length: 36 }, (_, i) => ["traveler", i]), ["provider", 0], ["admin", 0], ["platform", 0]];
let renewStop = false;
void (async () => { let n = 0; await sleep(200_000); while (!renewStop) { const [name, i] = renew[n++ % renew.length]; try { const key = name === "traveler" ? `traveler-${i}` : name; w.sessions.delete(key); await w.actor(name, i); } catch { /* next round */ } await sleep(10_000); } })();
const traffic = startTraffic(w, st, { rate });
const canary = [];
let canaryStop = false;
void (async () => { while (!canaryStop) { const r = await call(run.base, "GET", "/health/live", {}); canary.push({ t: Date.now(), ms: r.ms, status: r.status }); await sleep(1000); } })();

const windows = [];
const begin = Date.now();
const end = begin + minutes * 60_000;
let prevSnap = await snapshot(w.sql, { exactRows: false });
let prevLogAt = Math.floor(Date.now() / 1000);
console.log(`soak ${label}: ${minutes} min at ${rate} req/s, window ${windowS} s, db ${dbName}`);
while (Date.now() < end) {
  await sleep(windowS * 1000);
  const to = Date.now(), from = to - windowS * 1000;
  const sum = summarize(traffic.samples, from, to);
  const metrics = await scrapeMetrics(run, run.METRICS_TOKEN);
  const apiD = dockerStats(run.apiContainer), pgD = dockerStats(run.pgContainer);
  const conn = await w.sql.query(`SELECT state, count(*)::int AS n FROM pg_stat_activity WHERE usename = 'safry_runtime' GROUP BY state`);
  const connByState = Object.fromEntries(conn.rows.map((r) => [r.state ?? "null", r.n]));
  const snap = await snapshot(w.sql, { exactRows: false });
  const tableDelta = {};
  for (const [name, t] of Object.entries(snap.tables)) {
    const p = prevSnap.tables[name];
    if (p && (t.total !== p.total || t.dead !== p.dead || t.autovacuumCount !== p.autovacuumCount)) tableDelta[name] = { totalDeltaB: t.total - p.total, dead: t.dead, autovacuumRuns: t.autovacuumCount - p.autovacuumCount };
  }
  let logBytes = 0, logLines = 0, errLines = [];
  try {
    const sinceTs = new Date(prevLogAt * 1000).toISOString();
    const out = execFileSync("docker", ["logs", "--since", sinceTs, run.apiContainer], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    prevLogAt = Math.floor(to / 1000);
    logBytes = Buffer.byteLength(out); logLines = out.split("\n").filter(Boolean).length;
    errLines = out.split("\n").filter((l) => /"level":"(error|warn|fatal)"/.test(l)).map((l) => { try { return JSON.parse(l).message?.slice(0, 120) ?? l.slice(0, 120); } catch { return l.slice(0, 120); } });
  } catch { /* leave zeros */ }
  const c = canary.filter((x) => x.t >= from && x.t < to).map((x) => x.ms);
  const row = {
    minute: round((to - begin) / 60000, 2), n: sum.all.n, ok: sum.all.ok, s5xx: sum.all.s5xx, s429: sum.all.s429, neterr: sum.all.neterr, p50: sum.all.p50, p95: sum.all.p95, p99: sum.all.p99, per: sum.per,
    dropped: traffic.dropped, inflight: traffic.inflight,
    rssMiB: round(metrics.rss / 1048576), heapMiB: round(metrics.heap / 1048576), apiMemMiB: round(apiD.memMiB), apiCpuPct: apiD.cpuPct, pgMemMiB: round(pgD.memMiB), pgCpuPct: pgD.cpuPct,
    canaryMaxMs: round(Math.max(...c, 0)), canaryP95Ms: round(stats(c).p95), connections: connByState, connTotal: Object.values(connByState).reduce((a, b) => a + b, 0),
    dbMiB: round(snap.dbBytes / 1048576, 2), tableDelta, logLines, logBytes, errLogLines: errLines.length, errLogSample: errLines.slice(0, 3)
  };
  windows.push(row);
  prevSnap = snap;
  console.log(`t=${String(row.minute).padStart(5)}m n=${row.n} p95=${row.p95} p99=${row.p99} 5xx=${row.s5xx} 429=${row.s429} rss=${row.rssMiB}M heap=${row.heapMiB}M apiCpu=${row.apiCpuPct}% pgCpu=${row.pgCpuPct}% conn=${row.connTotal} canaryMax=${row.canaryMaxMs} db=${row.dbMiB}M log=${row.logBytes}B/${row.logLines}l err=${row.errLogLines} drop=${row.dropped}`);
}
traffic.stop(); canaryStop = true;
await sleep(2000);

// ---------------------------------------------------------------- verdict
const tenMin = Math.max(1, Math.round(600 / windowS));
const first = windows.slice(0, tenMin), last = windows.slice(-tenMin);
const mean = (rows, k) => rows.reduce((s, r) => s + r[k], 0) / Math.max(1, rows.length);
const totalReq = windows.reduce((s, r) => s + r.n, 0), totalBad = windows.reduce((s, r) => s + (r.n - r.ok), 0);
const perNames = [...new Set(windows.flatMap((r) => Object.keys(r.per)))];
const p95Doubling = [];
for (const name of perNames) {
  const f = first.map((r) => r.per[name]).filter((x) => x && x.ok > 0), l = last.map((r) => r.per[name]).filter((x) => x && x.ok > 0);
  if (f.length && l.length) { const fm = f.reduce((s, x) => s + x.p95, 0) / f.length, lm = l.reduce((s, x) => s + x.p95, 0) / l.length; if (lm > 2 * fm && lm > 50) p95Doubling.push({ name, first10: round(fm), last10: round(lm) }); }
}
const errCounts = {};
for (const r of windows) for (const m of r.errLogSample) errCounts[m] = (errCounts[m] ?? 0) + 1;
const verdict = {
  errorRatePct: round((totalBad / Math.max(1, totalReq)) * 100, 3), errorRateFlag: totalBad / Math.max(1, totalReq) > 0.02,
  overallP95First10: round(mean(first, "p95")), overallP95Last10: round(mean(last, "p95")), p95DoubledEndpoints: p95Doubling,
  rssFirst10: round(mean(first, "rssMiB")), rssLast10: round(mean(last, "rssMiB")), rssGrowthPct: round(((mean(last, "rssMiB") - mean(first, "rssMiB")) / Math.max(1, mean(first, "rssMiB"))) * 100),
  maxConnections: Math.max(...windows.map((r) => r.connTotal)), poolMax, connectionsFlag: Math.max(...windows.map((r) => r.connTotal)) > poolMax,
  repeatedBackgroundErrors: Object.entries(errCounts).filter(([, n]) => n >= 3).map(([message, windowsSeen]) => ({ message, windowsSeen })),
  maxCanaryMs: Math.max(...windows.map((r) => r.canaryMaxMs)), dropped: traffic.dropped
};
verdict.rssFlag = verdict.rssGrowthPct > 10;
const totalLogBytes = windows.reduce((s, r) => s + r.logBytes, 0), totalLogLines = windows.reduce((s, r) => s + r.logLines, 0);
const first10Snap = windows[0], lastSnap = windows[windows.length - 1];
const summary = {
  label, run: run.run, db: dbName, minutes, rate, windowS, startedAt: new Date(begin).toISOString(), requests: totalReq,
  logBytesTotal: totalLogBytes, logLinesTotal: totalLogLines, logBytesPerRequest: round(totalLogBytes / Math.max(1, totalReq), 1), logBytesPerMinute: Math.round(totalLogBytes / minutes), logMiBPerHourExtrapolated: round(((totalLogBytes / minutes) * 60) / 1048576, 1),
  dbMiBStart: windows[0].dbMiB, dbMiBEnd: lastSnap.dbMiB, verdict
};
saveJson(`soak-${run.run}-${label}.json`, { summary, windows });
console.log(JSON.stringify(summary, null, 1));
await w.close();
process.exit(0);
