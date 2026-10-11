import { describe, expect, it } from "vitest";
import { devWalRefusal, unsafeRuntimeLogin } from "./prisma.service.js";

describe("unsafeRuntimeLogin", () => {
  it("refuses an owner, owner-member, superuser or BYPASSRLS login in production", () => {
    expect(unsafeRuntimeLogin({ privileged: false, owner: true }, true)).toMatch(/safry_runtime/);
    expect(unsafeRuntimeLogin({ privileged: true, owner: false }, true)).toMatch(/safry_runtime/);
  });
  it("accepts a restricted login in production and anything outside production", () => {
    expect(unsafeRuntimeLogin({ privileged: false, owner: false }, true)).toBeUndefined();
    expect(unsafeRuntimeLogin({ privileged: true, owner: true }, false)).toBeUndefined();
  });
});

describe("devWalRefusal", () => {
  it("refuses a database that still has the prisma dev WAL schema, in production only", () => {
    expect(devWalRefusal(true, true)).toMatch(/_prisma_dev_wal/);
    expect(devWalRefusal(true, false)).toBeUndefined();
    expect(devWalRefusal(false, true)).toBeUndefined();
  });
});
