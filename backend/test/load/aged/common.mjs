// Shared helpers for the aged-database harness (local use only). Plain Node, no dependency besides `pg` from backend/node_modules.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA = join(HERE, "..", ".data", "aged");
mkdirSync(DATA, { recursive: true });

export function loadRunEnv(run) {
  const text = readFileSync(join(DATA, `${run}.env`), "utf8");
  const env = Object.fromEntries(text.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const pgPort = run === "a" ? 55621 : 55622;
  const apiPort = run === "a" ? 3201 : 3202;
  return {
    ...env,
    run,
    pgPort,
    apiPort,
    base: `http://127.0.0.1:${apiPort}/api/v1`,
    ownerUrl: (db = "safry") => `postgresql://safry:${env.OWNER_PW}@127.0.0.1:${pgPort}/${db}`,
    apiContainer: `safry-aged-${run}-api`,
    pgContainer: `safry-aged-${run}-pg`
  };
}

export const parseArgs = (argv = process.argv.slice(2)) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[argv[i].slice(2)] = true;
    else { out[argv[i].slice(2)] = next; i++; }
  }
  return out;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN);
export function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, min: s[0] ?? NaN, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1] ?? NaN, mean: s.length ? sum / s.length : NaN };
}
export const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
let xffCounter = Math.floor(Math.random() * 60000);
/** A unique client address per call, so the per-address rate limiters (TRUST_PROXY=1) never mix callers. */
export const nextIp = () => {
  xffCounter += 1;
  return `10.${(xffCounter >> 16) & 255}.${(xffCounter >> 8) & 255}.${xffCounter & 255}`;
};

/** One HTTP call. Returns { status, ms, body, headers, bytes }. ms = time to the full response body. */
export function call(base, method, path, { token, tenantId, body, headers = {}, ip, native = true, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const url = new URL(base + path);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const started = process.hrtime.bigint();
    const req = http.request(
      {
        agent, hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, timeout,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(native ? { "x-client": "mobile" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(tenantId ? { "x-tenant-id": tenantId } : {}),
          "x-forwarded-for": ip ?? nextIp(),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = { text }; }
          resolve({ status: res.statusCode, ms, body: parsed, bytes: text.length, headers: res.headers });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, ms: Number(process.hrtime.bigint() - started) / 1e6, body: { error: String(e.message) }, bytes: 0, headers: {} }));
    if (payload) req.write(payload);
    req.end();
  });
}

export async function ownerClient(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

export const saveJson = (name, value) => writeFileSync(join(DATA, name), JSON.stringify(value, null, 2));
export const loadJson = (name) => JSON.parse(readFileSync(join(DATA, name), "utf8"));
export const hasJson = (name) => existsSync(join(DATA, name));

/** Docker helpers (the API and database run in containers). */
import { execFileSync } from "node:child_process";
export const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
export function dockerStats(container) {
  // "12.3MiB / 768MiB|15.2%"
  try {
    const [mem, cpu] = docker("stats", "--no-stream", "--format", "{{.MemUsage}}|{{.CPUPerc}}", container).split("|");
    const used = /([\d.]+)\s*(KiB|MiB|GiB)/.exec(mem);
    const mult = { KiB: 1 / 1024, MiB: 1, GiB: 1024 }[used?.[2] ?? "MiB"];
    return { memMiB: Number(used?.[1] ?? NaN) * mult, cpuPct: Number(cpu.replace("%", "")) };
  } catch { return { memMiB: NaN, cpuPct: NaN }; }
}
export async function scrapeMetrics(run, token) {
  const r = await call(run.base, "GET", "/metrics", { headers: { authorization: `Bearer ${token}` } });
  const text = typeof r.body?.text === "string" ? r.body.text : "";
  const num = (name) => Number(new RegExp(`^${name} ([\\d.e+-]+)`, "m").exec(text)?.[1] ?? NaN);
  return { rss: num("safry_process_resident_memory_bytes"), heap: num("safry_process_heap_used_bytes"), text };
}
