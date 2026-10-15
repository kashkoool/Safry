// Soak: a low, constant request rate (the mixed traveler scenario) held for a long time, watching for slow degradation:
// latency drift and API process memory growth. Nothing here tries to find the breaking point (that is run.mjs).
//   node soak.mjs --url http://127.0.0.1:3100 --minutes 30 --rate 20 --pid <api pid> [--window 60] [--label soak]
// --pid is the API process: its resident memory is sampled every window (Linux /proc, or `ps`). Without it only latency is judged.
// Verdict (exit 1 on a breach), comparing the first and the last third of the windows after a warm-up of 3 windows:
//   p95 grew by more than soak.maxP95DriftRatio, memory (RSS) grew by more than soak.maxRssGrowthPct,
//   error-response rate above soak.maxErrorRatePct, or a window ended with no completed request.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import autocannon from "autocannon";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), [])
);
const base = (args.url ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const minutes = Number(args.minutes ?? 30);
const rate = Number(args.rate ?? 20); // requests per second over all connections
const windowSeconds = Number(args.window ?? 60);
const label = args.label ?? "soak";
const pid = args.pid ? Number(args.pid) : null;
const limits = JSON.parse(readFileSync(new URL("./thresholds.json", import.meta.url), "utf8")).soak;
const data = JSON.parse(readFileSync(new URL("./.data/tokens.json", import.meta.url), "utf8"));
const travelers = data.tokens.filter((t) => t.role === "traveler");
let cursor = 0;
const as = (request) => {
  const who = travelers[cursor++ % travelers.length];
  request.headers = { ...request.headers, authorization: `Bearer ${who.token}`, "x-tenant-id": who.tenantId };
  return request;
};
const requests = ["/auth/me", "/bookings", "/services/marketplace"].map((path) => ({ method: "GET", path: `/api/v1${path}`, setupRequest: as }));
requests.push({ method: "POST", path: "/api/v1/auth/activity", setupRequest: as });

function rssMb() {
  if (!pid) return null;
  try {
    const kb = process.platform === "linux"
      ? Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1])
      : Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
    return Number.isFinite(kb) ? Math.round(kb / 1024) : null;
  } catch { return null; }
}
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const windows = [];
const count = Math.max(1, Math.round((minutes * 60) / windowSeconds));
for (let i = 0; i < count; i++) {
  const samples = [];
  const run = autocannon({ url: base, connections: 8, duration: windowSeconds, overallRate: rate, requests, timeout: 30 });
  run.on("response", (_c, _s, _b, time) => samples.push(time));
  const result = await run;
  samples.sort((a, b) => a - b);
  const bad = result.non2xx + result.errors + result.timeouts;
  const row = { window: i + 1, requests: result.requests.total, p50: pct(samples, 50), p95: pct(samples, 95), p99: pct(samples, 99), bad, rssMb: rssMb() };
  windows.push(row);
  console.log(JSON.stringify(row));
}

const warm = Math.min(3, Math.floor(count / 4));
const usable = windows.slice(warm);
const third = Math.max(1, Math.floor(usable.length / 3));
const mean = (rows, key) => rows.reduce((sum, r) => sum + r[key], 0) / Math.max(1, rows.length);
const first = usable.slice(0, third);
const last = usable.slice(-third);
const total = windows.reduce((s, w) => s + w.requests, 0);
const bad = windows.reduce((s, w) => s + w.bad, 0);
const p95Ratio = mean(first, "p95") > 0 ? mean(last, "p95") / mean(first, "p95") : 1;
const hasRss = windows.every((w) => w.rssMb !== null);
const rssGrowthPct = hasRss && mean(first, "rssMb") > 0 ? ((mean(last, "rssMb") - mean(first, "rssMb")) / mean(first, "rssMb")) * 100 : null;
const errorPct = (bad / Math.max(1, total + bad)) * 100;
const failures = [];
if (p95Ratio > limits.maxP95DriftRatio) failures.push(`p95 drift x${p95Ratio.toFixed(2)} > x${limits.maxP95DriftRatio}`);
if (rssGrowthPct !== null && rssGrowthPct > limits.maxRssGrowthPct) failures.push(`RSS growth ${rssGrowthPct.toFixed(1)}% > ${limits.maxRssGrowthPct}%`);
if (errorPct > limits.maxErrorRatePct) failures.push(`errors ${errorPct.toFixed(3)}% > ${limits.maxErrorRatePct}%`);
if (windows.some((w) => w.requests === 0)) failures.push("a window completed no request");

mkdirSync(new URL("./.data/", import.meta.url), { recursive: true });
const summary = { label, url: base, minutes, rate, windowSeconds, at: new Date().toISOString(), p95Ratio, rssGrowthPct, errorPct, failures, windows };
writeFileSync(new URL(`./.data/soak-${label}.json`, import.meta.url), JSON.stringify(summary, null, 2));
console.log(
  `\n| windows | requests | p95 first third (ms) | p95 last third (ms) | p95 drift | RSS first (MB) | RSS last (MB) | RSS growth | error % | verdict |\n|---|---|---|---|---|---|---|---|---|---|\n` +
    `| ${count} | ${total} | ${mean(first, "p95").toFixed(0)} | ${mean(last, "p95").toFixed(0)} | x${p95Ratio.toFixed(2)} | ${hasRss ? mean(first, "rssMb").toFixed(0) : "-"} | ${hasRss ? mean(last, "rssMb").toFixed(0) : "-"} | ${rssGrowthPct === null ? "-" : rssGrowthPct.toFixed(1) + "%"} | ${errorPct.toFixed(3)} | ${failures.length ? "FAIL" : "ok"} |`
);
if (failures.length) { console.error(`\nSoak failed: ${failures.join("; ")}`); process.exit(1); }
