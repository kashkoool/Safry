import { describe, expect, it } from "vitest";
import { assertDevDatabase, scriptRefusal } from "./script-guard.js";

describe("script guard", () => {
  it("allows a local database", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(scriptRefusal({ DATABASE_URL: `postgresql://u:p@${host}:5432/d` })).toBeUndefined();
  });
  it("refuses production, remote hosts and a missing or malformed URL", () => {
    expect(scriptRefusal({ NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@localhost/d" })).toContain("production");
    expect(scriptRefusal({ DATABASE_URL: "postgresql://u:p@db.prod.example.com/d" })).toContain("non-local");
    expect(scriptRefusal({})).toContain("not set");
    expect(scriptRefusal({ DATABASE_URL: "nonsense" })).toContain("not a valid URL");
    expect(() => assertDevDatabase("smoke", { DATABASE_URL: "postgresql://u:p@postgres:5432/d" })).toThrow("smoke refused");
  });
  it("can be overridden deliberately", () => {
    expect(scriptRefusal({ ALLOW_REMOTE_SCRIPT: "true", NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@x.example.com/d" })).toBeUndefined();
  });
});
