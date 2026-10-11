import { describe, expect, it } from "vitest";
import { evaluate, parseAudit, type AllowEntry } from "./audit-prod.js";

const allow: AllowEntry[] = [{ ghsa: "GHSA-aaaa-aaaa-aaaa", package: "x", reason: "unreachable", reviewBy: "2027-01-10" }];
const found = (ghsa: string) => ({ ghsa, module: "m", severity: "high" });

describe("audit allowlist", () => {
  it("accepts a listed advisory and still fails on a new one", () => {
    expect(evaluate([found("GHSA-aaaa-aaaa-aaaa")], allow, "2026-10-10").failures).toEqual([]);
    const result = evaluate([found("GHSA-aaaa-aaaa-aaaa"), found("GHSA-bbbb-bbbb-bbbb")], allow, "2026-10-10");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("GHSA-bbbb-bbbb-bbbb");
    expect(result.accepted).toHaveLength(1); // survivor: the listed one is still reported as accepted
  });
  it("fails again once an entry passes its review date, and reports entries that are no longer needed", () => {
    expect(evaluate([found("GHSA-aaaa-aaaa-aaaa")], allow, "2027-02-01").failures).toHaveLength(1);
    expect(evaluate([], allow, "2026-10-10")).toMatchObject({ failures: [], stale: ["GHSA-aaaa-aaaa-aaaa"] });
  });
  it("parses the pnpm output and refuses output it does not understand", () => {
    expect(parseAudit(JSON.stringify({ advisories: { 1: { github_advisory_id: "GHSA-x", module_name: "m", severity: "low" } } }))).toEqual([{ ghsa: "GHSA-x", module: "m", severity: "low" }]);
    expect(parseAudit(JSON.stringify({ advisories: {} }))).toEqual([]);
    expect(() => parseAudit(JSON.stringify({ error: { code: "x" } }))).toThrow();
    expect(() => parseAudit("not json")).toThrow();
    expect(() => parseAudit(JSON.stringify({ advisories: { 1: { module_name: "m" } } }))).toThrow();
  });
});
