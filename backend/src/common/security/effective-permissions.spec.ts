import { describe, expect, it } from "vitest";
import { effectivePermissions } from "./effective-permissions.js";
describe("effective permissions", () => {
  it("denies a role grant when explicitly revoked", () =>
    expect(effectivePermissions(["booking.create", "booking.read"], { "booking.create": false })).toEqual([
      "booking.read"
    ]));
  it("supports explicit grants without duplicating inherited permissions", () =>
    expect(effectivePermissions(["booking.read"], { "booking.read": true, "booking.create": true })).toEqual([
      "booking.create",
      "booking.read"
    ]));
  it("never yields a platform permission, from a role or an override", () =>
    expect(effectivePermissions(["platform.tenant.create", "tenant.read"], { "platform.anything": true })).toEqual([
      "tenant.read"
    ]));
  it("ignores nonboolean values and malformed JSON", () => {
    expect(effectivePermissions(["booking.read"], null)).toEqual(["booking.read"]);
    expect(effectivePermissions([], { admin: "true" })).toEqual([]);
  });
});
