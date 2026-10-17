import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { isUniqueViolation, mapDatabaseError } from "./database-errors.js";
import { ServiceBusyException } from "./service-busy.exception.js";

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
    expect(mapDatabaseError(new Error("boom"))).toBeUndefined();
    expect(mapDatabaseError("text")).toBeUndefined();
    expect(mapDatabaseError(null)).toBeUndefined();
    expect(mapDatabaseError({ name: "Other", code: "P2002" })).toBeUndefined();
  });
});

describe("mapDatabaseError under overload", () => {
  it.each(["P2024", "P2028", "P2037", "P1008"])("maps Prisma %s (pool wait, transaction wait, too many connections, timeout) to a retryable 503", (code) => {
    const mapped = mapDatabaseError(prismaError(code));
    expect(mapped).toBeInstanceOf(ServiceBusyException);
    expect(mapped).toBeInstanceOf(ServiceUnavailableException);
    expect((mapped as ServiceBusyException).retryAfterSeconds).toBeGreaterThan(0);
    expect(mapped?.message).not.toContain(code);
  });

  it("maps PostgreSQL too_many_connections and cannot_connect_now to 503 and never echoes driver text", () => {
    const tooMany = mapDatabaseError({ name: "error", code: "53300", severity: "FATAL", message: 'remaining connection slots are reserved for role "admin"' });
    expect(tooMany).toBeInstanceOf(ServiceBusyException);
    expect(tooMany?.message).not.toContain("admin");
    expect(mapDatabaseError({ name: "error", code: "57P03", severity: "FATAL", message: "the database system is starting up" })).toBeInstanceOf(ServiceBusyException);
  });

  it("maps the pool connect timeout of the driver to 503", () => {
    expect(mapDatabaseError(new Error("timeout exceeded when trying to connect"))).toBeInstanceOf(ServiceBusyException);
    expect(mapDatabaseError(new Error("sorry, too many clients already"))).toBeInstanceOf(ServiceBusyException);
  });

  it("does not turn an unrelated 5-character code or a plain error into 503", () => {
    expect(mapDatabaseError({ name: "error", code: "53100", severity: "ERROR", message: "disk full" })).toBeUndefined();
    expect(mapDatabaseError(prismaError("P2010"))).toBeUndefined();
    expect(mapDatabaseError(new Error("something timeout exceeded elsewhere"))).toBeUndefined();
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
