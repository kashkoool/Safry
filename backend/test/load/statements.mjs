// Counts the SQL statements (= database round trips) one request costs, via pg_stat_statements.
//   LOAD_DATABASE_URL=... node statements.mjs --url http://127.0.0.1:3100
// The API must run against the same database (the extension is preloaded by the load-test Postgres).
import { readFileSync } from "node:fs";
import pg from "pg";

const args = Object.fromEntries(process.argv.slice(2).reduce((p, v, i, all) => (v.startsWith("--") ? [...p, [v.slice(2), all[i + 1]]] : p), []));
const base = (args.url ?? "http://127.0.0.1:3100").replace(/\/$/, "");
// The bearer token read below must never leave this machine: refuse any target that is not loopback.
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error(`refusing non-loopback target: ${base}`);
const data = JSON.parse(readFileSync(new URL("./.data/tokens.json", import.meta.url), "utf8"));
const traveler = data.tokens.find((t) => t.role === "traveler");
const client = new pg.Client({ connectionString: process.env.LOAD_DATABASE_URL });
await client.connect();
await client.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
const call = (method, path) =>
  fetch(`${base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${traveler.token}`, "x-tenant-id": traveler.tenantId } }).then(async (r) => {
    await r.arrayBuffer();
    return r.status;
  });
for (const [name, method, path] of [["GET /auth/me", "GET", "/auth/me"], ["POST /auth/activity", "POST", "/auth/activity"], ["GET /bookings", "GET", "/bookings"]]) {
  await call(method, path); // warm-up
  await new Promise((resolve) => setTimeout(resolve, 150));
  await client.query("SELECT pg_stat_statements_reset()");
  const status = await call(method, path);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const { rows } = await client.query("SELECT COALESCE(SUM(calls),0)::int AS n FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%'");
  console.log(JSON.stringify({ request: name, status, statements: rows[0].n }));
}
await client.end();
