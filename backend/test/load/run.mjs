// Load scenarios for the Safry API (autocannon). The API under test is started separately; see README.md.
//   node run.mjs --url http://127.0.0.1:3100 --duration 20 --label baseline [--only me,bookings_traveler]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import autocannon from "autocannon";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), [])
);
const base = (args.url ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const prefix = `${base}/api/v1`;
const duration = Number(args.duration ?? 20);
const label = args.label ?? "run";
const only = args.only ? args.only.split(",") : null;
const data = JSON.parse(readFileSync(new URL("./.data/tokens.json", import.meta.url), "utf8"));
const byRole = (role) => data.tokens.filter((t) => t.role === role);
const travelers = byRole("traveler");
const providers = byRole("service-provider");
const admins = byRole("tenant-admin");

let cursor = 0;
const pick = (pool) => pool[cursor++ % pool.length];
const auth = (pool) => (request) => {
  const who = pick(pool);
  request.headers = { ...request.headers, authorization: `Bearer ${who.token}`, "x-tenant-id": who.tenantId };
  if (request.path.endsWith("/bookings") && request.method === "POST") {
    const date = new Date(Date.now() + (1 + (cursor % 60)) * 86_400_000).toISOString().slice(0, 10);
    request.body = JSON.stringify({ serviceId: data.hot[who.tenantId], travelersCount: 1, serviceDate: date });
  }
  return request;
};
const get = (path, pool) => ({ method: "GET", path: `/api/v1${path}`, setupRequest: auth(pool) });
const post = (path, pool, body) => ({
  method: "POST", path: `/api/v1${path}`, headers: { "content-type": "application/json" }, ...(body ? { body } : {}), setupRequest: auth(pool)
});

/** name -> { connections, requests }. Heavy list scenarios use fewer connections on purpose. */
const scenarios = {
  health_live: { connections: 64, requests: [{ method: "GET", path: "/api/v1/health/live" }] },
  health_ready: { connections: 32, requests: [{ method: "GET", path: "/api/v1/health/ready" }] },
  me: { connections: 64, requests: [get("/auth/me", travelers)] },
  activity: { connections: 64, requests: [post("/auth/activity", travelers)] },
  bookings_traveler: { connections: 32, requests: [get("/bookings", travelers)] },
  bookings_admin: { connections: 8, requests: [get("/bookings", admins)] },
  marketplace: { connections: 16, requests: [get("/services/marketplace", travelers)] },
  services_provider: { connections: 16, requests: [get("/services", providers)] },
  booking_create_hot: { connections: 16, requests: [post("/bookings", travelers, "{}")] },
  mixed_traveler: {
    connections: 48,
    requests: [get("/auth/me", travelers), get("/bookings", travelers), get("/services/marketplace", travelers), post("/auth/activity", travelers)]
  }
};

const results = [];
for (const [name, scenario] of Object.entries(scenarios)) {
  if (only && !only.includes(name)) continue;
  const samples = [];
  const instance = autocannon({ url: base, connections: scenario.connections, duration, requests: scenario.requests, timeout: 30 });
  instance.on("response", (_client, _status, _bytes, time) => samples.push(time));
  const result = await instance;
  samples.sort((a, b) => a - b);
  const pct = (p) => (samples.length ? samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))] : 0);
  const non2xx = result.non2xx;
  const row = {
    scenario: name, connections: scenario.connections, rps: Math.round(result.requests.average),
    p50: pct(50), p95: pct(95), p99: pct(99),
    max: result.latency.max, total: result.requests.total, non2xx, errors: result.errors, timeouts: result.timeouts,
    errorRatePct: Number((((non2xx + result.errors + result.timeouts) / Math.max(1, result.requests.total + result.errors + result.timeouts)) * 100).toFixed(2)),
    statusCounts: Object.fromEntries(["1xx", "2xx", "3xx", "4xx", "5xx"].map((k) => [k, result[k]]).filter(([, v]) => v))
  };
  results.push(row);
  console.log(JSON.stringify(row));
}
mkdirSync(new URL("./.data/", import.meta.url), { recursive: true });
writeFileSync(new URL(`./.data/result-${label}.json`, import.meta.url), JSON.stringify({ label, url: base, duration, at: new Date().toISOString(), results }, null, 2));
console.log("\n| scenario | conns | RPS | p50 ms | p95 ms | p99 ms | max ms | error % |\n|---|---|---|---|---|---|---|---|");
for (const r of results) console.log(`| ${r.scenario} | ${r.connections} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.errorRatePct} |`);
