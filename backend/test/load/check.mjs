// Gate for a load run: fails on an error-response rate above maxErrorRatePct or a p99 above the scenario's limit.
//   node check.mjs [--label ci] [--thresholds thresholds.json]
// Prints a Markdown table (append it to $GITHUB_STEP_SUMMARY). Exit code 1 on any breach or a missing scenario.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), [])
);
const label = args.label ?? "ci";
const limits = JSON.parse(readFileSync(args.thresholds ? pathToFileURL(resolve(args.thresholds)) : new URL("./thresholds.json", import.meta.url), "utf8"));
const run = JSON.parse(readFileSync(new URL(`./.data/result-${label}.json`, import.meta.url), "utf8"));

const seen = new Set();
const failures = [];
const rows = run.results.map((r) => {
  seen.add(r.scenario);
  const limit = limits.p99Ms[r.scenario];
  const problems = [];
  if (limit === undefined) problems.push("no p99 limit defined");
  else if (r.p99 > limit) problems.push(`p99 ${r.p99} ms > ${limit} ms`);
  if (r.errorRatePct > limits.maxErrorRatePct) problems.push(`errors ${r.errorRatePct}% > ${limits.maxErrorRatePct}%`);
  if (problems.length) failures.push(`${r.scenario}: ${problems.join(", ")}`);
  return `| ${r.scenario} | ${r.connections} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${limit ?? "-"} | ${r.errorRatePct} | ${problems.length ? "FAIL" : "ok"} |`;
});
for (const name of Object.keys(limits.p99Ms)) if (!seen.has(name)) failures.push(`${name}: scenario did not run`);

console.log("| scenario | conns | RPS | p50 ms | p95 ms | p99 ms | p99 limit ms | error % | result |\n|---|---|---|---|---|---|---|---|---|");
console.log(rows.join("\n"));
if (failures.length) {
  console.error(`\nLoad gate failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nLoad gate passed (${run.results.length} scenarios, ${run.duration} s each, error rate <= ${limits.maxErrorRatePct}%).`);
