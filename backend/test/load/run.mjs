// Load scenarios for the Safry API (autocannon). The API under test is started separately; see README.md.
//   node run.mjs --url http://127.0.0.1:3100 --duration 20 --label baseline [--only me,bookings_traveler]
//   node run.mjs --only login_storm --steps 10,25,50,100,200 --label knee   (same scenario at each connection count)
// Scenarios marked "limiter" need an API started with LOAD_LIMITER=on (see start-api.sh): every simulated client has its own
// address, sent in X-Forwarded-For, which the API trusts through TRUST_PROXY=1. They run only with --profile limiter or --only.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import autocannon from "autocannon";
import pg from "pg";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), [])
);
const base = (args.url ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const duration = Number(args.duration ?? 20);
const label = args.label ?? "run";
const profile = args.profile ?? null; // "limiter": the limiter-on scenarios only
const only = args.only ? args.only.split(",") : null;
const steps = args.steps ? args.steps.split(",").map(Number) : null;
const connectionsOverride = args.connections ? Number(args.connections) : null;
const data = JSON.parse(readFileSync(new URL("./.data/tokens.json", import.meta.url), "utf8"));
const byRole = (role) => data.tokens.filter((t) => t.role === role);
const travelers = byRole("traveler");
const providers = byRole("service-provider");
const admins = byRole("tenant-admin");
const contenders = byRole("contender");
const tenantCodes = data.tenantCodes ?? [];

/** Distinct private address number n, so each simulated client has its own rate-limit bucket. */
const ipFor = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
let counter = 0;
const unique = (prefix) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;
const nativeJson = { "content-type": "application/json", "x-client": "mobile" };
const jsonPost = (path, bodyOf, ipBase) => ({
  method: "POST", path: `/api/v1${path}`, headers: nativeJson,
  setupRequest: (request) => {
    request.headers = { ...request.headers, "x-forwarded-for": ipFor(ipBase + counter++) };
    request.body = JSON.stringify(bodyOf());
    return request;
  }
});

let cursor = 0;
const pick = (pool) => pool[cursor++ % pool.length];
const auth = (pool) => (request) => {
  const who = pick(pool);
  request.headers = {
    ...request.headers, authorization: `Bearer ${who.token}`, "x-tenant-id": who.tenantId, "x-forwarded-for": ipFor(1 + data.tokens.indexOf(who))
  };
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

let loginCursor = 0;
const loginBody = () => {
  const index = loginCursor++;
  const tenant = index % tenantCodes.length;
  const n = 1 + (Math.floor(index / tenantCodes.length) % data.travelersPerTenant);
  return { email: `trav-${tenant}-${n}@example.test`, password: data.password, tenantCode: tenantCodes[tenant] };
};
const contentionDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
let contenderCursor = 0;

const wantsContention = only ? only.includes("booking_contention") : profile === "limiter";
const db = process.env.LOAD_DATABASE_URL && wantsContention ? new pg.Client({ connectionString: process.env.LOAD_DATABASE_URL }) : null;
if (db) await db.connect();

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
  },
  // --- limiter scenarios: start the API with LOAD_LIMITER=on ---
  // Many distinct users signing in at once, each from its own address; real argon2 behind the gate (4 running + 64 queued).
  login_storm: {
    limiter: true, connections: 100,
    requests: [jsonPost("/auth/login", loginBody, 2_000_000)]
  },
  // New accounts, each from a fresh address (the per-address limit is 5 a minute); the console mail transport logs the mails.
  registration_storm: {
    limiter: true, connections: 20,
    requests: [
      jsonPost("/auth/register/customer", () => ({
        displayName: "Load Test", email: `${unique("reg")}@example.test`, password: `${data.password}-reg`, tenantCode: tenantCodes[0] ?? "load-0"
      }), 3_000_000)
    ]
  },
  // One request per contender, spread over the contention services (all capacity on one date). 201 = seat taken, 409 = full.
  booking_contention: {
    limiter: true, connections: 100, amount: contenders.length, expect: [201, 409],
    prepare: async () => {
      if (db) await db.query(`DELETE FROM bookings WHERE "serviceId" = ANY($1::uuid[])`, [data.contention.serviceIds]);
      contenderCursor = 0;
    },
    check: async (row) => {
      if (!db) return;
      const { rows } = await db.query(
        `SELECT "serviceId" AS id, COALESCE(SUM(units),0)::int AS taken FROM bookings WHERE "serviceId" = ANY($1::uuid[]) AND status <> 'CANCELLED' GROUP BY "serviceId"`,
        [data.contention.serviceIds]
      );
      const taken = rows.map((r) => r.taken);
      const oversold = taken.filter((n) => n > data.contention.capacity).length;
      const created = row.statusCounts["201"] ?? 0;
      const seatsTaken = taken.reduce((a, b) => a + b, 0);
      row.contention = { services: data.contention.serviceIds.length, capacity: data.contention.capacity, attempts: row.total, seatsTaken, created, oversoldServices: oversold };
      const free = data.contention.serviceIds.length * data.contention.capacity;
      if (oversold > 0 || seatsTaken !== created || (row.total >= free && created !== free)) row.problem = `oversold ${oversold}, seats ${seatsTaken}, created ${created}, expected ${Math.min(free, row.total)}`;
    },
    requests: [
      {
        method: "POST", path: "/api/v1/bookings", headers: { "content-type": "application/json" },
        setupRequest: (request) => {
          const index = contenderCursor++;
          const who = contenders[index % contenders.length];
          request.headers = { ...request.headers, authorization: `Bearer ${who.token}`, "x-tenant-id": who.tenantId, "x-forwarded-for": ipFor(4_000_000 + index) };
          request.body = JSON.stringify({ serviceId: data.contention.serviceIds[index % data.contention.serviceIds.length], travelersCount: 1, serviceDate: contentionDate });
          return request;
        }
      }
    ]
  },
  // The 429 path: one address sends far more than its per-minute ceiling. 200 until the ceiling, 429 afterwards; nothing may be 5xx.
  limiter_single_ip: {
    limiter: true, connections: 32, expect: [200, 429],
    requests: [
      {
        method: "GET", path: "/api/v1/auth/me",
        setupRequest: (request) => {
          const who = travelers[0];
          request.headers = { ...request.headers, authorization: `Bearer ${who.token}`, "x-tenant-id": who.tenantId, "x-forwarded-for": "10.250.250.250" };
          return request;
        }
      }
    ]
  }
};

const results = [];
for (const [name, scenario] of Object.entries(scenarios)) {
  if (only ? !only.includes(name) : profile === "limiter" ? !scenario.limiter : scenario.limiter) continue;
  for (const connections of steps ?? [connectionsOverride ?? scenario.connections]) {
    await scenario.prepare?.();
    const samples = [];
    const instance = autocannon({
      url: base, connections, requests: scenario.requests, timeout: 30, ...(scenario.amount ? { amount: scenario.amount } : { duration })
    });
    instance.on("response", (_client, _status, _bytes, time) => samples.push(time));
    const result = await instance;
    samples.sort((a, b) => a - b);
    const pct = (p) => (samples.length ? samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))] : 0);
    const statusCounts = Object.fromEntries(Object.entries(result.statusCodeStats ?? {}).map(([code, v]) => [code, v.count]));
    const expected = new Set(scenario.expect ?? []);
    const count = (predicate) => Object.entries(statusCounts).filter(([code]) => predicate(Number(code))).reduce((sum, [, n]) => sum + n, 0);
    // Bad = a response that is neither 2xx nor listed in the scenario's expected statuses, plus connection errors and timeouts.
    const bad = count((code) => (code < 200 || code >= 300) && !expected.has(code));
    const badTotal = bad + result.errors + result.timeouts;
    const row = {
      scenario: steps ? `${name}@${connections}` : name, connections, rps: Math.round(result.requests.average),
      p50: pct(50), p95: pct(95), p99: pct(99),
      max: result.latency.max, total: result.requests.total, non2xx: result.non2xx, errors: result.errors, timeouts: result.timeouts,
      count429: statusCounts["429"] ?? 0, count5xx: count((code) => code >= 500), badResponses: bad,
      errorRatePct: Number(((badTotal / Math.max(1, result.requests.total + result.errors + result.timeouts)) * 100).toFixed(2)),
      statusCounts
    };
    await scenario.check?.(row);
    results.push(row);
    console.log(JSON.stringify(row));
  }
}
await db?.end();
mkdirSync(new URL("./.data/", import.meta.url), { recursive: true });
writeFileSync(new URL(`./.data/result-${label}.json`, import.meta.url), JSON.stringify({ label, url: base, duration, at: new Date().toISOString(), results }, null, 2));
console.log("\n| scenario | conns | RPS | p50 ms | p95 ms | p99 ms | max ms | error % | 429 | 5xx |\n|---|---|---|---|---|---|---|---|---|---|");
for (const r of results) console.log(`| ${r.scenario} | ${r.connections} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.errorRatePct} | ${r.count429} | ${r.count5xx} |`);
if (results.some((r) => r.problem)) {
  console.error(`\nCorrectness problem: ${results.filter((r) => r.problem).map((r) => `${r.scenario}: ${r.problem}`).join("; ")}`);
  process.exitCode = 1;
}
