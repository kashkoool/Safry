// Virtual-user workload: N simulated people, each signed in for real (POST /auth/login, native client so the refresh token
// is in the body), each from its own address (X-Forwarded-For, trusted through TRUST_PROXY=1), who repeatedly pick an action
// at a fixed ratio, wait a random think time, and rotate their refresh token now and then. Run against an API started
// with LOAD_LIMITER=on. This measures USERS, not open connections: 200 users with a 4 s think time are about 50 requests/s.
//   node vu.mjs --url http://127.0.0.1:3100 --users 200 --seconds 180 --think 4000 --ramp 60 --label mixed_users
//   node vu.mjs --users 100 --seconds 600 --label steady_state --pid <API process id>      (sustained run)
// Output: .data/result-<label>.json (same shape as run.mjs, so check.mjs can gate it) and one line per minute.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), [])
);
const base = (args.url ?? "http://127.0.0.1:3100").replace(/\/$/, "");
// The sign-in password in .data/tokens.json must never leave this machine: refuse any non-loopback target.
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname) && args["allow-remote"] !== "yes") {
  throw new Error(`refusing non-loopback target ${base} (pass --allow-remote yes for a deliberate run against another host)`);
}
const users = Number(args.users ?? 200);
const seconds = Number(args.seconds ?? 180);
const thinkMs = Number(args.think ?? 4000);
const rampSeconds = Number(args.ramp ?? Math.max(10, Math.ceil(users / 5)));
const label = args.label ?? "mixed_users";
const pid = args.pid ? Number(args.pid) : null;
const data = JSON.parse(readFileSync(new URL("./.data/tokens.json", import.meta.url), "utf8"));
const prefix = `${base}/api/v1`;

/** Action mix of one traveler session: list, detail-ish reads, own bookings, and a token refresh now and then. */
const MIX = [
  ["marketplace", 40, "GET", "/services/marketplace"],
  ["services", 15, "GET", "/services"],
  ["bookings", 25, "GET", "/bookings"],
  ["me", 12, "GET", "/auth/me"],
  ["refresh", 8, "POST", "/auth/refresh"]
];
const total = MIX.reduce((sum, m) => sum + m[1], 0);
const chooseAction = () => {
  let roll = Math.random() * total;
  for (const m of MIX) if ((roll -= m[1]) < 0) return m;
  return MIX[0];
};
const ipFor = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exponential = (mean) => -Math.log(1 - Math.random()) * mean;

const latencies = []; // [startedAtMs, ms, kind, status]
const perMinute = [];
let window = [];
const record = (kind, ms, status) => {
  latencies.push([Date.now(), ms, kind, status]);
  window.push([ms, status]);
};

async function call(vu, method, path, body) {
  const started = performance.now();
  let status = 0;
  try {
    const response = await fetch(`${prefix}${path}`, {
      method,
      headers: {
        "x-forwarded-for": vu.ip, "x-client": "mobile", "content-type": "application/json",
        ...(vu.access ? { authorization: `Bearer ${vu.access}`, "x-tenant-id": vu.tenantId } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000)
    });
    status = response.status;
    const text = await response.text();
    return { status, json: status < 300 && text ? JSON.parse(text) : null, ms: performance.now() - started };
  } catch {
    return { status: 0, json: null, ms: performance.now() - started };
  }
}

async function signIn(vu) {
  const result = await call(vu, "POST", "/auth/login", { email: vu.email, password: data.password, tenantCode: vu.tenantCode });
  record("login", result.ms, result.status);
  if (result.status !== 200 || !result.json?.accessToken) return false;
  vu.access = result.json.accessToken;
  vu.refresh = result.json.refreshToken;
  return true;
}

async function refresh(vu) {
  const result = await call(vu, "POST", "/auth/refresh", { refreshToken: vu.refresh });
  record("refresh", result.ms, result.status);
  if (result.status === 200 && result.json?.accessToken) {
    vu.access = result.json.accessToken;
    vu.refresh = result.json.refreshToken;
  }
}

const endAt = Date.now() + (rampSeconds + seconds) * 1000;
async function runUser(index) {
  const tenant = index % data.tenantCodes.length;
  const n = 1 + (Math.floor(index / data.tenantCodes.length) % data.travelersPerTenant);
  const vu = {
    ip: ipFor(5_000_000 + index), tenantCode: data.tenantCodes[tenant], email: `trav-${tenant}-${n}@example.test`,
    tenantId: data.tokens.find((t) => t.tenantCode === data.tenantCodes[tenant])?.tenantId, access: null, refresh: null
  };
  await sleep((index / users) * rampSeconds * 1000);
  if (!(await signIn(vu))) return;
  while (Date.now() < endAt) {
    await sleep(exponential(thinkMs));
    const [kind, , method, path] = chooseAction();
    if (kind === "refresh") await refresh(vu);
    else {
      const result = await call(vu, method, path);
      record(kind, result.ms, result.status);
      if (result.status === 401) await refresh(vu);
    }
  }
}

const rssMb = () => {
  if (!pid) return null;
  try {
    const out = execFileSync(process.platform === "win32" ? "powershell" : "ps", process.platform === "win32"
      ? ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64 / 1MB`] : ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    return Math.round(process.platform === "win32" ? Number(out) : Number(out) / 1024);
  } catch {
    return null;
  }
};
const quantile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const summarize = (rows) => {
  const sorted = rows.map((r) => r[0]).sort((a, b) => a - b);
  return { count: rows.length, p50: Math.round(quantile(sorted, 0.5)), p95: Math.round(quantile(sorted, 0.95)), p99: Math.round(quantile(sorted, 0.99)) };
};

const ticker = setInterval(() => {
  const s = summarize(window);
  const bad = window.filter(([, status]) => status === 0 || status >= 400).length;
  const line = { minute: perMinute.length + 1, ...s, bad, rssMb: rssMb() };
  perMinute.push({ ...line, p95All: s.p95 });
  console.log(JSON.stringify(line));
  window = [];
}, 60_000);

const started = Date.now();
await Promise.all(Array.from({ length: users }, (_, i) => runUser(i)));
clearInterval(ticker);
const elapsed = (Date.now() - started) / 1000;

// Steady-state numbers ignore the ramp-up (logins) so the table describes the workload, not the sign-in wave.
const steady = latencies.filter(([at, , kind]) => kind !== "login" && at >= started + rampSeconds * 1000);
const logins = latencies.filter(([, , kind]) => kind === "login");
const statusCounts = {};
for (const [, , , status] of latencies) statusCounts[status] = (statusCounts[status] ?? 0) + 1;
const stats = summarize(steady.map(([, ms]) => [ms]));
// Errors count every request after sign-in, ramp-up included: a sign-in wave that breaks other users' reads must show up.
const afterLogin = latencies.filter(([, , kind]) => kind !== "login");
const badSteady = afterLogin.filter(([, , , status]) => status === 0 || (status >= 400 && status !== 429)).length;
const count429 = latencies.filter(([, , , status]) => status === 429).length;
const loginsOk = logins.filter(([, , , status]) => status === 200).length;
const p95Of = (rows) => summarize(rows.map(([, ms]) => [ms])).p95;
const warm = steady.filter(([at]) => at >= started + (rampSeconds + 60) * 1000);
const third = Math.floor(warm.length / 3);
const drift = warm.length > 30 ? p95Of(warm.slice(-third)) / Math.max(1, p95Of(warm.slice(0, third))) : null;
const rss = perMinute.map((m) => m.rssMb).filter((v) => v != null);
const row = {
  scenario: label, connections: users, users, thinkMs, rampSeconds, seconds, rps: Number((steady.length / Math.max(1, seconds)).toFixed(1)),
  p50: stats.p50, p95: stats.p95, p99: stats.p99, max: Math.round(Math.max(0, ...steady.map(([, ms]) => ms))),
  total: afterLogin.length, errors: badSteady, timeouts: 0, non2xx: badSteady, badResponses: badSteady, count429, count5xx: latencies.filter(([, , , s]) => s >= 500).length,
  errorRatePct: Number(((badSteady / Math.max(1, afterLogin.length)) * 100).toFixed(3)),
  loginsOk, loginsTried: logins.length, loginP95: summarize(logins.map(([, ms]) => [ms])).p95,
  byAction: Object.fromEntries(MIX.map(([kind]) => [kind, summarize(steady.filter(([, , k]) => k === kind).map(([, ms]) => [ms]))])),
  statusCounts, p95DriftRatio: drift === null ? null : Number(drift.toFixed(2)),
  rssGrowthPct: rss.length > 4 ? Number((((rss.at(-1) - rss[2]) / rss[2]) * 100).toFixed(1)) : null, elapsedSeconds: Math.round(elapsed)
};
console.log(JSON.stringify(row));
mkdirSync(new URL("./.data/", import.meta.url), { recursive: true });
writeFileSync(new URL(`./.data/result-${label}.json`, import.meta.url), JSON.stringify({ label, url: base, duration: seconds, at: new Date().toISOString(), perMinute, results: [row] }, null, 2));
if (loginsOk < users) {
  console.error(`only ${loginsOk} of ${users} users could sign in`);
  process.exitCode = 1;
}
