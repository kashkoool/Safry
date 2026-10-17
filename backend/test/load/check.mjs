// Gate for a load run: fails on an error-response rate above the limit or a latency above the scenario's limit.
//   node check.mjs [--label ci] [--set base|limiter|users] [--thresholds thresholds.json]
// --set base (default): thresholds.json "p99Ms" (one p99 limit per scenario). --set limiter / users: the rule objects in
// thresholds.json "limiter" / "users": { p99Ms, p95Ms, maxErrorRatePct, min429, max429, max5xx, maxP95DriftRatio, maxRssGrowthPct }.
// Prints a Markdown table (append it to $GITHUB_STEP_SUMMARY). Exit code 1 on any breach or a missing scenario.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), [])
);
const label = args.label ?? "ci";
const set = args.set ?? "base";
const limits = JSON.parse(readFileSync(args.thresholds ? pathToFileURL(resolve(args.thresholds)) : new URL("./thresholds.json", import.meta.url), "utf8"));
const run = JSON.parse(readFileSync(new URL(`./.data/result-${label}.json`, import.meta.url), "utf8"));
const rules = set === "base" ? Object.fromEntries(Object.entries(limits.p99Ms).map(([name, p99Ms]) => [name, { p99Ms }])) : limits[set];
if (!rules) throw new Error(`no threshold set "${set}" in thresholds.json`);
const defaultErrorPct = limits.maxErrorRatePct;

const seen = new Set();
const failures = [];
const rows = run.results.map((r) => {
  seen.add(r.scenario);
  const rule = rules[r.scenario];
  const problems = [];
  if (!rule) problems.push("no limit defined");
  else {
    if (rule.p99Ms !== undefined && r.p99 > rule.p99Ms) problems.push(`p99 ${r.p99} ms > ${rule.p99Ms} ms`);
    if (rule.p95Ms !== undefined && r.p95 > rule.p95Ms) problems.push(`p95 ${r.p95} ms > ${rule.p95Ms} ms`);
    // errorRatePct in the result file is rounded; compare the exact rate from the raw counts when they are there.
    const badCount = (r.badResponses ?? r.non2xx ?? 0) + (r.errors ?? 0) + (r.timeouts ?? 0);
    const exact = Number.isFinite(r.total) ? (badCount / Math.max(1, r.total + (r.errors ?? 0) + (r.timeouts ?? 0))) * 100 : r.errorRatePct;
    const maxError = rule.maxErrorRatePct ?? defaultErrorPct;
    if (exact > maxError) problems.push(`errors ${exact.toFixed(4)}% > ${maxError}%`);
    if (rule.min429 !== undefined && (r.count429 ?? 0) < rule.min429) problems.push(`429 count ${r.count429 ?? 0} < ${rule.min429}`);
    if (rule.max429 !== undefined && (r.count429 ?? 0) > rule.max429) problems.push(`429 count ${r.count429} > ${rule.max429}`);
    if (rule.max5xx !== undefined && (r.count5xx ?? 0) > rule.max5xx) problems.push(`5xx count ${r.count5xx} > ${rule.max5xx}`);
    if (rule.maxP95DriftRatio !== undefined && r.p95DriftRatio != null && r.p95DriftRatio > rule.maxP95DriftRatio) problems.push(`p95 drift ${r.p95DriftRatio}x > ${rule.maxP95DriftRatio}x`);
    if (rule.maxRssGrowthPct !== undefined && r.rssGrowthPct != null && r.rssGrowthPct > rule.maxRssGrowthPct) problems.push(`memory +${r.rssGrowthPct}% > ${rule.maxRssGrowthPct}%`);
  }
  if (r.problem) problems.push(r.problem);
  if (problems.length) failures.push(`${r.scenario}: ${problems.join(", ")}`);
  const limitText = rule ? (rule.p99Ms !== undefined ? `p99 ${rule.p99Ms}` : rule.p95Ms !== undefined ? `p95 ${rule.p95Ms}` : "-") : "-";
  return `| ${r.scenario} | ${r.connections} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${limitText} | ${r.errorRatePct} | ${r.count429 ?? 0} | ${problems.length ? "FAIL" : "ok"} |`;
});
for (const name of Object.keys(rules)) if (!seen.has(name)) failures.push(`${name}: scenario did not run`);

console.log("| scenario | conns/users | RPS | p50 ms | p95 ms | p99 ms | limit ms | error % | 429 | result |\n|---|---|---|---|---|---|---|---|---|---|");
console.log(rows.join("\n"));
if (failures.length) {
  console.error(`\nLoad gate failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nLoad gate passed (${run.results.length} scenarios, ${run.duration} s each, default error rate limit ${defaultErrorPct}%).`);
