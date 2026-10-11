import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `pnpm audit --prod` with a documented allowlist: the known, unreachable advisories in audit-allowlist.json
 * are reported but accepted; any other advisory, an expired allowlist entry, or an audit that could not be read FAILS.
 *   pnpm audit:prod
 */
export interface AllowEntry {
  ghsa: string;
  package: string;
  reason: string;
  reviewBy: string;
}
export interface Found {
  ghsa: string;
  module: string;
  severity: string;
}

export function evaluate(found: Found[], allow: AllowEntry[], today: string): { failures: string[]; accepted: string[]; stale: string[] } {
  const failures: string[] = [];
  const accepted: string[] = [];
  const byId = new Map(allow.map((entry) => [entry.ghsa, entry]));
  for (const advisory of found) {
    const entry = byId.get(advisory.ghsa);
    const label = `${advisory.ghsa} (${advisory.severity}, ${advisory.module})`;
    if (!entry) failures.push(`NEW advisory not in the allowlist: ${label}`);
    else if (!entry.reason.trim() || entry.reviewBy < today) failures.push(`allowlist entry needs re-review (reviewBy ${entry.reviewBy}) or a reason: ${label}`);
    else accepted.push(`${label}: ${entry.reason}`);
  }
  const present = new Set(found.map((advisory) => advisory.ghsa));
  const stale = allow.filter((entry) => !present.has(entry.ghsa)).map((entry) => entry.ghsa);
  return { failures, accepted, stale };
}

/** Pulls the advisories out of `pnpm audit --json`; throws on any shape it does not recognise (fail closed, never "clean by accident"). */
export function parseAudit(raw: string): Found[] {
  const data = JSON.parse(raw) as { advisories?: Record<string, { github_advisory_id?: string; module_name?: string; severity?: string }>; error?: unknown };
  if (!data || typeof data !== "object" || data.error || typeof data.advisories !== "object" || data.advisories === null)
    throw new Error("unrecognised `pnpm audit --json` output");
  return Object.values(data.advisories).map((advisory) => {
    if (!advisory.github_advisory_id) throw new Error("advisory without a GHSA id in the audit output");
    return { ghsa: advisory.github_advisory_id, module: advisory.module_name ?? "?", severity: advisory.severity ?? "?" };
  });
}

function main(): number {
  const allow = (JSON.parse(readFileSync(resolve(import.meta.dirname, "../audit-allowlist.json"), "utf8")) as { allow: AllowEntry[] }).allow;
  const run = spawnSync("pnpm", ["audit", "--prod", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
  if (run.error || !run.stdout) {
    console.error(`audit could not run: ${run.error?.message ?? run.stderr}`);
    return 2;
  }
  const result = evaluate(parseAudit(run.stdout), allow, new Date().toISOString().slice(0, 10));
  for (const line of result.accepted) console.log(`accepted  ${line}`);
  for (const id of result.stale) console.log(`note      ${id} is in the allowlist but no longer reported: remove it`);
  for (const line of result.failures) console.error(`FAIL      ${line}`);
  return result.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
