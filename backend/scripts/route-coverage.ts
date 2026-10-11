/**
 * Route-coverage gate. Reads the HTTP hits the integration suites recorded (test/.coverage/hits-*.jsonl, written by
 * World.api) and the routes the compiled app registers (dist/), and exits 1 when a route was never exercised, was never
 * reached with a success status, or (for a protected route) was never called without credentials or by a forbidden caller.
 * Run after the integration suites:  pnpm test:int && pnpm test:routes
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverRoutes } from "../test/support/routes.js";
import { COVERAGE_DIR } from "../test/support/coverage-dir.js";

interface Hit {
  method: string;
  path: string;
  status: number;
  authenticated: boolean;
}

/** Probes answer 2xx to everyone: no unauthenticated or negative case exists for them. */
const PROBES = new Set(["GET /health/live", "GET /health/ready"]);

const files = (() => {
  try {
    return readdirSync(COVERAGE_DIR).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
})();
if (files.length === 0) {
  console.error(`No recorded hits in ${COVERAGE_DIR}. Run the integration suites first (pnpm test:int).`);
  process.exit(1);
}
const hits: Hit[] = files.flatMap((name) =>
  readFileSync(join(COVERAGE_DIR, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Hit)
);


let failed = 0;
const report: string[] = [];
for (const route of discoverRoutes()) {
  const [method, path] = route.split(" ") as [string, string];
  const pattern = new RegExp(`^${path.split("/").map((segment) => (segment.startsWith(":") ? "[^/]+" : segment)).join("/")}$`);
  const own = hits.filter((hit) => hit.method === method && pattern.test(hit.path));
  const problems: string[] = [];
  if (own.length === 0) problems.push("never called");
  else if (PROBES.has(route)) {
    if (!own.some((hit) => hit.status === 200 && !hit.authenticated)) problems.push("no anonymous 200");
  }
  else if (!PROBES.has(route)) {
    if (!own.some((hit) => hit.status >= 200 && hit.status < 300)) problems.push("no 2xx");
    if (!own.some((hit) => hit.status === 401 || !hit.authenticated)) problems.push("no unauthenticated call");
    if (!own.some((hit) => hit.status >= 400 && hit.status < 500)) problems.push("no 4xx negative case");
  }
  if (problems.length > 0) {
    failed += 1;
    report.push(`  ${route.padEnd(58)} ${problems.join(", ")}`);
  }
}
console.log(`routes: ${discoverRoutes().length}, hits: ${hits.length}, routes with gaps: ${failed}`);
if (failed > 0) {
  console.error(`Routes missing coverage:\n${report.join("\n")}`);
  process.exit(1);
}
