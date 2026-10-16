// Run: node --test scripts/dast-check.test.mjs
// Proves the DAST gate fails on a Medium (or higher) alert and passes when only Low/Informational alerts remain.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const gate = fileURLToPath(new URL("./dast-check.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "dast-check-"));
const run = (alerts, name) => {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ site: [{ alerts }] }));
  return spawnSync(process.execPath, [gate, file], { encoding: "utf8" });
};
const alert = (riskcode, pluginid, name) => ({ riskcode: String(riskcode), pluginid, name, count: "1" });

test("fails on a Medium alert", () => {
  const result = run([alert(0, "10027", "Suspicious Comments"), alert(2, "10038", "Content Security Policy Header Not Set")], "medium");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Medium or higher/);
});

test("fails on a High alert", () => assert.equal(run([alert(3, "40012", "Cross Site Scripting")], "high").status, 1));

test("passes when only Low and Informational alerts remain", () => {
  const result = run([alert(1, "10049", "Storable and Cacheable Content"), alert(0, "10027", "Suspicious Comments")], "low");
  assert.equal(result.status, 0);
});

test("fails when the report has no site (the scan never reached the target)", () => {
  const file = join(dir, "empty.json");
  writeFileSync(file, JSON.stringify({ site: [] }));
  assert.equal(spawnSync(process.execPath, [gate, file], { encoding: "utf8" }).status, 1);
});
