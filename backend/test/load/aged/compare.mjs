// Prints the sweep comparison: aged vs fresh for one run, or run A vs run B (aged). Usage: node compare.mjs --run a | --ab
import { parseArgs, loadJson, hasJson } from "./common.mjs";
const args = parseArgs();
const key = (r) => `${r.route} | ${r.name}`;
const index = (file) => new Map(loadJson(file).results.map((r) => [key(r), r]));
const fmt = (v) => (Number.isFinite(v) ? String(v) : "-");
if (args.ab) {
  const a = index("sweep-a-safry.json"), b = index("sweep-b-safry.json");
  console.log("| route | case | A p50 | A p95 | A p99 | B p50 | B p95 | B p99 | B/A p95 | notes |\n|---|---|---|---|---|---|---|---|---|---|");
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y) continue;
    const ratio = x.p95 > 0 ? (y.p95 / x.p95).toFixed(2) : "-";
    const note = [x.ok < x.calls ? `A ok ${x.ok}/${x.calls}` : "", y.ok < y.calls ? `B ok ${y.ok}/${y.calls}` : ""].filter(Boolean).join("; ");
    console.log(`| ${x.route} | ${x.name} | ${fmt(x.p50)} | ${fmt(x.p95)} | ${fmt(x.p99)} | ${fmt(y.p50)} | ${fmt(y.p95)} | ${fmt(y.p99)} | ${ratio} | ${note} |`);
  }
} else {
  const run = args.run ?? "a";
  const aged = index(`sweep-${run}-safry.json`), fresh = index(`sweep-${run}-safry_fresh.json`);
  console.log("| route | case | calls ok | aged p50 | aged p95 | aged p99 | fresh p50 | fresh p95 | aged/fresh p95 | flag |\n|---|---|---|---|---|---|---|---|---|---|");
  for (const [k, x] of aged) {
    const f = fresh.get(k);
    const ratio = f && f.p95 > 0 ? x.p95 / f.p95 : NaN;
    const flag = [x.p95 > 300 ? ">300ms" : "", ratio > 2 && x.p95 - (f?.p95 ?? 0) > 10 ? ">2x fresh" : ""].filter(Boolean).join(", ");
    console.log(`| ${x.route} | ${x.name} | ${x.ok}/${x.calls} | ${fmt(x.p50)} | ${fmt(x.p95)} | ${fmt(x.p99)} | ${fmt(f?.p50)} | ${fmt(f?.p95)} | ${Number.isFinite(ratio) ? ratio.toFixed(2) : "-"} | ${flag} |`);
  }
}
