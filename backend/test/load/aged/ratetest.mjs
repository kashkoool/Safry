// Capacity probe: one request type at a fixed open-loop rate for N seconds; prints latency and the API container CPU.
//   node ratetest.mjs --run a --kind bookings|login|me|mixnologin --rate 25 --seconds 20
import { parseArgs, loadRunEnv, loadJson, call, stats, round, sleep, dockerStats } from "./common.mjs";
import { World } from "./world.mjs";
import { startTraffic, prewarm } from "./traffic.mjs";

const a = parseArgs();
const run = loadRunEnv(a.run ?? "a");
const actors = loadJson(`${run.run}-safry-actors.json`);
const w = await new World(run, actors, "safry").init();
w.mfaSecret = actors.platformMfaSecret;
const kind = a.kind ?? "bookings", rate = Number(a.rate ?? 25), seconds = Number(a.seconds ?? 20);
await prewarm(w, {});
const toks = [];
for (let i = 0; i < 36; i++) toks.push((await w.actor("traveler", i)).token);
const samples = [];
let n = 0, stop = false;
const t = setInterval(async () => {
  if (stop) return;
  const i = n++;
  const start = Date.now();
  let r;
  if (kind === "login") r = await call(run.base, "POST", "/auth/login", { body: { email: actors.travelers[i % 36].email, password: actors.password, tenantCode: actors.tenantCode } });
  else r = await call(run.base, "GET", kind === "me" ? "/auth/me" : "/bookings?limit=20", { token: toks[i % 36] });
  samples.push({ t: start, ms: r.ms, ok: r.status === 200 });
}, 1000 / rate);
await sleep(seconds / 2 * 1000);
const mid = dockerStats(run.apiContainer);
await sleep(seconds / 2 * 1000);
stop = true; clearInterval(t);
await sleep(3000);
const s = stats(samples.filter((x) => x.ok).map((x) => x.ms));
console.log(JSON.stringify({ kind, rate, sent: samples.length, ok: samples.filter((x) => x.ok).length, p50: round(s.p50), p95: round(s.p95), p99: round(s.p99), apiCpuPct: mid.cpuPct }));
await w.close();
process.exit(0);
