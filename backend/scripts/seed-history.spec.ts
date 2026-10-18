import { describe, expect, it } from "vitest";
import { assertSafeTarget, parseArgs, prng, uid } from "./seed-history.js";
import { purgeStatements } from "./db/run-purge.js";
import { formatBytes } from "./db/size-report.js";

const local = "postgresql://postgres:x@127.0.0.1:55432/safry_local";

describe("history seed safety", () => {
  it("refuses production, even for a local host", () => {
    expect(() => assertSafeTarget({ NODE_ENV: "production" }, local)).toThrow(/production/);
  });
  it("refuses any host that is not loopback", () => {
    for (const url of ["postgresql://u:p@db.internal:5432/safry", "postgresql://u:p@10.0.0.5/safry", "postgresql://u:p@localhost.evil.example/safry", "postgresql://u:p@safry.example.com/safry"])
      expect(() => assertSafeTarget({}, url), url).toThrow(/Refusing/);
    expect(() => assertSafeTarget({}, "not a url")).toThrow(/valid URL/);
  });
  it("accepts localhost, 127.0.0.1 and ::1 outside production", () => {
    for (const url of [local, "postgresql://u:p@localhost:5432/safry", "postgresql://u:p@[::1]:5432/safry"]) expect(() => assertSafeTarget({ NODE_ENV: "development" }, url), url).not.toThrow();
  });
  it("needs an explicit database and rejects unknown or out-of-range options", () => {
    expect(() => parseArgs([], {})).toThrow(/database/);
    expect(() => parseArgs(["--url", local, "--bogus", "1"], {})).toThrow(/Unknown option/);
    expect(() => parseArgs(["--url", local, "--scale", "0"], {})).toThrow(/between/);
    expect(parseArgs(["--", "--url", local, "--scale", "0.2"], {}).users).toBe(1000);
  });
});

describe("history seed determinism", () => {
  it("produces the same numbers and ids for the same seed", () => {
    const a = prng(7);
    const b = prng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(uid("user", 1)).toBe(uid("user", 1));
    expect(uid("user", 1)).not.toBe(uid("user", 2));
    expect(uid("user", 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("maintenance helpers", () => {
  it("builds the same four calls as purge.sh and rejects non-numbers", () => {
    expect(purgeStatements({})).toEqual([
      "CALL ensure_audit_event_partitions(0, 6)",
      "CALL purge_refresh_sessions(interval '30 days')",
      "CALL purge_credential_tokens(interval '7 days')",
      "CALL purge_audit_events(interval '24 months')"
    ]);
    expect(purgeStatements({ AUDIT_RETENTION_DAYS: "90" })[3]).toContain("90 days");
    expect(() => purgeStatements({ SESSION_RETENTION_DAYS: "1; DROP TABLE users" })).toThrow(/integer/);
  });
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.50 KiB");
  });
});
