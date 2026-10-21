// Disk extrapolation from the measured per user-day rows and bytes (growth-<run>-safry.json). Prints Markdown.
//   node extrapolate.mjs
import { loadJson } from "./common.mjs";

const g = { a: loadJson("growth-a-safry.json"), b: loadJson("growth-b-safry.json") };
const DAY = 30.44;
const gb = (bytes) => (bytes / 1e9 >= 10 ? (bytes / 1e9).toFixed(0) : (bytes / 1e9).toFixed(1));
const rate = (run, table) => { const t = g[run].perUserDay.tables[table]; return t ? { rows: t.rowsPerUnit, bytesPerRow: t.bytesPerRow ?? 0 } : { rows: 0, bytesPerRow: 0 }; };
const once = (run, table) => g[run].perNewUser.tables[table]?.bytesPerUnit ?? 0;
// retention windows in days (code defaults): sessions 30 d after expiry or revocation (a rotated session is revoked at once), links 7 d, audit 24 months, login counters ~1 d
const WINDOW = { refresh_sessions: 31, credential_tokens: 8, login_throttles: 1, audit_events: 730.5 };
const tables = ["audit_events", "refresh_sessions", "credential_tokens", "login_throttles", "bookings"];
function size(run, dau, months, purge) {
  const days = months * DAY;
  const out = {};
  let total = 0;
  for (const t of tables) {
    const { rows, bytesPerRow } = rate(run, t);
    const kept = purge && WINDOW[t] ? Math.min(days, WINDOW[t]) : days;
    out[t] = rows * dau * kept * bytesPerRow;
    total += out[t];
  }
  const oneTime = dau * (g[run].perNewUser.totalDbBytes);
  out.accounts = oneTime;
  total += oneTime;
  out.total = total;
  return out;
}
const rows = [];
rows.push("| DAU | months | A, no purge job (as the runbook ran it) | A, purge job running | B (PR 57, job on by default) | B audit_events | B refresh_sessions | A audit_events (job running) | A refresh_sessions (job running) |");
rows.push("|---|---|---|---|---|---|---|---|---|");
for (const dau of [1000, 10000])
  for (const months of [12, 24]) {
    const a0 = size("a", dau, months, false), a1 = size("a", dau, months, true), b1 = size("b", dau, months, true);
    rows.push(`| ${dau.toLocaleString("en")} | ${months} | ${gb(a0.total)} GB | ${gb(a1.total)} GB | ${gb(b1.total)} GB | ${gb(b1.audit_events)} GB | ${gb(b1.refresh_sessions)} GB | ${gb(a1.audit_events)} GB | ${gb(a1.refresh_sessions)} GB |`);
  }
console.log(rows.join("\n"));
console.log("\nPer table detail (GB), DAU x months, A no purge | A purge | B purge:");
for (const dau of [1000, 10000])
  for (const months of [12, 24]) {
    const a0 = size("a", dau, months, false), a1 = size("a", dau, months, true), b1 = size("b", dau, months, true);
    console.log(`\n${dau} DAU, ${months} months`);
    console.log("| table | A no purge | A purge job | B purge job |\n|---|---|---|---|");
    for (const t of [...tables, "accounts"]) console.log(`| ${t} | ${gb(a0[t])} | ${gb(a1[t])} | ${gb(b1[t])} |`);
    console.log(`| total | ${gb(a0.total)} | ${gb(a1.total)} | ${gb(b1.total)} |`);
  }
