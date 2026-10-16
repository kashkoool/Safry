// Fails (exit 1) when a ZAP JSON report contains an alert of risk Medium or higher. Rules ignored in .zap/rules.tsv
// are already absent from the report. Usage: node scripts/dast-check.mjs <report.json>
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/dast-check.mjs <report.json>"); process.exit(2); }
const report = JSON.parse(readFileSync(file, "utf8"));
const names = ["Informational", "Low", "Medium", "High"];
const alerts = (report.site ?? []).flatMap((site) => site.alerts ?? []);
if (!Array.isArray(report.site) || report.site.length === 0) { console.error("ZAP report has no site: the scan did not reach the target"); process.exit(1); }
const rows = alerts.map((a) => ({ risk: Number(a.riskcode), name: a.name, id: a.pluginid, count: Number(a.count ?? (a.instances ?? []).length) }));
rows.sort((a, b) => b.risk - a.risk);
console.log("| risk | rule | alert | instances |\n|---|---|---|---|");
for (const r of rows) console.log(`| ${names[r.risk] ?? r.risk} | ${r.id} | ${r.name} | ${r.count} |`);
const blocking = rows.filter((r) => r.risk >= 2);
if (blocking.length) { console.error(`\n${blocking.length} alert(s) of risk Medium or higher`); process.exit(1); }
console.log(`\n${rows.length} alert(s), none of risk Medium or higher`);
