import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { isUniqueViolation, mapDatabaseError } from "./database-errors.js";

const prismaError = (code: string): object => ({ name: "PrismaClientKnownRequestError", code, message: `Invalid invocation... ${code}` });

describe("mapDatabaseError", () => {
  it("maps unique, foreign-key and missing-record errors", () => {
    expect(mapDatabaseError(prismaError("P2002"))).toBeInstanceOf(ConflictException);
    expect(mapDatabaseError(prismaError("P2003"))).toBeInstanceOf(ConflictException);
    expect(mapDatabaseError(prismaError("P2025"))).toBeInstanceOf(NotFoundException);
  });

  it("maps a row-level-security violation to 403 without leaking details", () => {
    const rls = mapDatabaseError({ message: 'new row violates row-level security policy for table "bookings"' });
    expect(rls).toBeInstanceOf(ForbiddenException);
    expect(rls?.message).not.toContain("bookings");
    expect(mapDatabaseError({ message: 'Database error. Code: `42501`. Message: `new row violates row-level security policy for table "x"`' })).toBeInstanceOf(ForbiddenException);
  });

  it("a plain permission-denied (42501, e.g. a missing GRANT) is not turned into a client 403", () => {
    expect(mapDatabaseError({ message: "Database error. Code: `42501`. Message: `permission denied for table bookings`" })).toBeUndefined();
    expect(mapDatabaseError({ message: "permission denied for procedure purge_audit_events" })).toBeUndefined();
  });

  it("leaves everything else to the generic handler", () => {
    expect(mapDatabaseError(prismaError("P2024"))).toBeUndefined();
    expect(mapDatabaseError(new Error("boom"))).toBeUndefined();
    expect(mapDatabaseError("text")).toBeUndefined();
    expect(mapDatabaseError(null)).toBeUndefined();
    expect(mapDatabaseError({ name: "Other", code: "P2002" })).toBeUndefined();
  });
});

describe("isUniqueViolation", () => {
  it("is true only for a P2002 error object", () => {
    expect(isUniqueViolation(prismaError("P2002"))).toBe(true);
    expect(isUniqueViolation(prismaError("P2025"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("P2002")).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
  });
});
