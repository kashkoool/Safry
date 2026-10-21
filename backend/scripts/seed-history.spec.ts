import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  it("refuses URLs that redirect the driver to another server than the URL host", () => {
    for (const url of [
      "postgresql://u:p@localhost/safry?host=prod.example.com",
      "postgresql://u:p@localhost/safry?hostaddr=10.1.2.3",
      "postgresql://u:p@localhost/safry?service=prod",
      "postgresql://u:p@localhost/safry?options=-c%20search_path%3Dx",
      "postgresql://u:p@localhost/safry?host=%2Fvar%2Frun%2Fpostgresql",
      "postgresql://u:p@localhost/safry?host=/var/run/postgresql"
    ])
      expect(() => assertSafeTarget({}, url), url).toThrow(/Refusing/);
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
  it("builds the same calls as purge.sh and rejects non-numbers and out-of-range values", () => {
    expect(purgeStatements({})).toEqual([
      "CALL maintenance_ensure_partitions(6)",
      "SELECT purge_refresh_sessions_batch(interval '30 days', 5000)",
      "SELECT purge_credential_tokens_batch(interval '7 days', 5000)",
      "SELECT purge_login_throttles_batch(interval '24 hours', 5000)",
      "SELECT sweep_expired_bookings_batch(interval '48 hours', 5000)",
      "SELECT anonymise_deleted_users_batch(interval '30 days', 5000)",
      "SELECT scrub_audit_ip_addresses_batch(interval '90 days', 5000)",
      "CALL purge_audit_events(interval '24 months')",
      "CALL record_maintenance_run('purge')"
    ]);
    expect(purgeStatements({ AUDIT_RETENTION_DAYS: "90" })[7]).toContain("90 days");
    expect(purgeStatements({ ANONYMISE_DELETED_USERS_AFTER_DAYS: "0", AUDIT_IP_RETENTION_DAYS: "0" }).some((sql) => /anonymise|scrub/.test(sql))).toBe(false);
    expect(purgeStatements({ PURGE_DRY_RUN: "1" })).toEqual([
      "SELECT anonymise_deleted_users_count(interval '30 days')",
      "SELECT scrub_audit_ip_addresses_count(interval '90 days')"
    ]);
    expect(() => purgeStatements({ ANONYMISE_DELETED_USERS_AFTER_DAYS: "3651" })).toThrow(/from 0 to 3650/);
    expect(() => purgeStatements({ SESSION_RETENTION_DAYS: "1; DROP TABLE users" })).toThrow(/integer/);
    expect(() => purgeStatements({ AUDIT_RETENTION_DAYS: "5" })).toThrow(/from 30 to 3650/);
    expect(() => purgeStatements({ AUDIT_RETENTION_DAYS: "1" })).toThrow(/from 30 to 3650/);
    expect(() => purgeStatements({ SESSION_RETENTION_DAYS: "0" })).toThrow(/from 1 to 3650/);
    expect(() => purgeStatements({ AUDIT_PARTITIONS_AHEAD: "25" })).toThrow(/from 1 to 24/);
    expect(() => purgeStatements({ PURGE_BATCH_SIZE: "1" })).toThrow(/from 100 to 100000/);
  });
  it("purge.sh runs the same procedures in the same order as the Node helper", () => {
    const script = readFileSync(resolve(import.meta.dirname, "db/purge.sh"), "utf8");
    const fromScript = [...script.matchAll(/(?:-c|drain) "(?:CALL|SELECT) (\w+)\(/g)].map((match) => match[1]).filter((name) => !name!.endsWith("_count")); // the dry-run block counts only
    const fromHelper = purgeStatements({}).map((sql) => /^(?:CALL|SELECT) (\w+)\(/.exec(sql)![1]);
    expect(fromScript).toEqual(fromHelper);
  });
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.50 KiB");
  });
});
