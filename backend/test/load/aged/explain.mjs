// EXPLAIN (ANALYZE, BUFFERS) for the SQL behind the slowest read endpoints, on the aged database.
//   node explain.mjs --run a --db safry --cases "records audit search actor,records bookings search q=user0042,..."
// For each case: the request is replayed with statement logging (log_min_duration_statement = 0) switched on, the logged SELECTs of that
// request are collected with their parameters and the session settings (role, tenant) the application set, and the longest ones are
// re-run under EXPLAIN (ANALYZE, BUFFERS) inside a rolled-back transaction as the same restricted role. Read-only SELECT statements only.
import { parseArgs, loadRunEnv, loadJson, saveJson, call, docker, sleep, round } from "./common.mjs";
import { World } from "./world.mjs";
import { buildCases } from "./cases.mjs";
import { discover } from "./discover.mjs";

const args = parseArgs();
const run = loadRunEnv(args.run ?? "a");
const dbName = args.db ?? "safry";
const wanted = String(args.cases ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const actors = loadJson(`${run.run}-${dbName}-actors.json`);
const w = await new World(run, actors, dbName).init();
w.mfaSecret = actors.platformMfaSecret;
const st = await discover(w);
const cases = buildCases(w, st);
const pg = run.pgContainer;
const psql = (sql) => docker("exec", "-e", `PGPASSWORD=${run.OWNER_PW}`, pg, "psql", "-U", "safry", "-d", "postgres", "-Atc", sql);

psql("ALTER SYSTEM SET log_min_duration_statement = 0");
psql("SELECT pg_reload_conf()");
await sleep(1500);

function parseLog(text) {
  // entries start with "YYYY-MM-DD HH:MM:SS.mmm UTC [pid] LOG:" ; continuation lines follow
  const entries = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ \w+) \[(\d+)\] (LOG|DETAIL|STATEMENT|ERROR):\s?(.*)$/.exec(line);
    if (m) { cur = { pid: m[2], kind: m[3], text: m[4] }; entries.push(cur); } else if (cur) cur.text += `\n${line}`;
  }
  const out = [];
  let last = null;
  for (const e of entries) {
    if (e.kind === "LOG") {
      const d = /^duration: ([\d.]+) ms\s+(?:execute [^:]*|statement):\s*([\s\S]*)$/.exec(e.text);
      if (d) { last = { pid: e.pid, ms: Number(d[1]), sql: d[2].trim(), params: null }; out.push(last); }
    } else if (e.kind === "DETAIL" && last && last.pid === e.pid) {
      const p = /^Parameters?: ([\s\S]*)$/i.exec(e.text);
      if (p) {
        const params = [];
        const re = /\$(\d+) = (NULL|'((?:[^']|'')*)')/g;
        let mm;
        while ((mm = re.exec(p[1]))) params[Number(mm[1]) - 1] = mm[2] === "NULL" ? null : mm[3].replace(/''/g, "'");
        last.params = params;
      }
    }
  }
  return out;
}

const report = [];
for (const key of wanted) {
  const c = cases.find((x) => `${x.route} ${x.name}`.toLowerCase().includes(key.toLowerCase()));
  if (!c) { console.log(`no case matches "${key}"`); continue; }
  const r0 = c.req(0, undefined);
  const token = (await w.actor(c.actor, 0)).token;
  await call(run.base, r0.method, r0.path, { token, body: r0.body });   // warm
  const mark = new Date(Date.now() - 500).toISOString();
  const resp = await call(run.base, r0.method, r0.path, { token, body: r0.body });
  await sleep(800);
  const log = docker("logs", "--since", mark, pg);
  const statements = parseLog(log);
  // session settings per pid: the most recent set_config call before each data statement
  const settings = {};
  const data = [];
  for (const s of statements) {
    if (/set_config\(/i.test(s.sql) && s.params) settings[s.pid] = { sql: s.sql, params: s.params };
    else if (/^\s*(SELECT|WITH)/i.test(s.sql) && /FROM\s+"public"\./i.test(s.sql)) data.push({ ...s, session: settings[s.pid] ?? null });
  }
  data.sort((a, b) => b.ms - a.ms);
  const plans = [];
  for (const d of data.slice(0, Number(args.top ?? 2))) {
    const lines = [];
    const client = w.sql;
    try {
      await client.query("BEGIN");
      if (d.session) await client.query(d.session.sql.replace(/\$(\d+)/g, (_m, n) => `$${n}`), d.session.params);
      await client.query(`PREPARE ex_stmt AS ${d.sql}`);
      const lit = (d.params ?? []).map((p) => (p === null ? "NULL" : `'${String(p).replace(/'/g, "''")}'`)).join(", ");
      const plan = await client.query(`EXPLAIN (ANALYZE, BUFFERS) EXECUTE ex_stmt${lit ? `(${lit})` : ""}`);
      for (const row of plan.rows) lines.push(row["QUERY PLAN"]);
    } catch (e) { lines.push(`EXPLAIN failed: ${e.message}`); }
    finally { await client.query("ROLLBACK").catch(() => undefined); }
    const text = lines.join("\n");
    plans.push({ loggedMs: d.ms, sql: d.sql.slice(0, 1500), params: d.params, sessionSettings: d.session?.params ?? null, flags: { seqScan: /Seq Scan/.test(text), parallel: /Parallel/.test(text), indexScan: /Index (Only )?Scan/.test(text), bitmap: /Bitmap/.test(text), gin: /gin|trgm/i.test(text), sortExternal: /external merge/.test(text), maxRowsRemovedByFilter: Math.max(0, ...[...text.matchAll(/Rows Removed by Filter: (\d+)/g)].map((m) => Number(m[1]))) }, executionTime: /Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? null, plan: text });
  }
  report.push({ case: `${c.route} ${c.name}`, httpMs: round(resp.ms), statementsLogged: statements.length, dataStatements: data.length, totalLoggedSqlMs: round(data.reduce((s, d) => s + d.ms, 0)), plans });
  console.log(`${c.route} ${c.name}: http ${round(resp.ms)} ms, ${data.length} data statements, plans ${plans.length}`);
}
psql("ALTER SYSTEM RESET log_min_duration_statement");
psql("SELECT pg_reload_conf()");
saveJson(`explain-${run.run}-${dbName}.json`, report);
await w.close();
process.exit(0);
