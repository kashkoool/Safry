import { ForbiddenException, Logger, UnauthorizedException, type ArgumentsHost } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter, describeDatabaseError } from "./all-exceptions.filter.js";


function run(
  error: unknown,
  request: Record<string, unknown> = { method: "POST", originalUrl: "/api/v1/x?secret=1" }
): { status: number; body: { message: unknown } } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: (): unknown => ({ getResponse: (): unknown => ({ status }), getRequest: (): unknown => request })
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(error, host);
  return { status: status.mock.calls[0]?.[0] as number, body: json.mock.calls[0]?.[0] as { message: unknown } };
}

describe("AllExceptionsFilter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers 413 for a body-parser payload-too-large error instead of 500", () => {
    const tooLarge = Object.assign(new Error("request entity too large"), { status: 413, type: "entity.too.large" });
    const { status, body } = run(tooLarge);
    expect(status).toBe(413);
    expect(body.message).toBe("Payload too large");
  });

  it("maps other client errors from the HTTP layer to their own 4xx and never echoes their text", () => {
    const bad = Object.assign(new Error("internal parser detail"), { statusCode: 415 });
    const { status, body } = run(bad);
    expect(status).toBe(415);
    expect(JSON.stringify(body)).not.toContain("parser detail");
  });

  it("still answers 500 for an unknown error and for a non-client status", () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    expect(run(new Error("boom")).status).toBe(500);
    expect(run(Object.assign(new Error("x"), { status: 200 })).status).toBe(500);
  });

  it("logs 401 and 403 denials with method and path but without the query string", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    run(new ForbiddenException("no"), { method: "DELETE", originalUrl: "/api/v1/roles/1?token=abc", user: { userId: "u-1", tenantId: "t-1" } });
    run(new UnauthorizedException());
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("403") && l.includes("DELETE /api/v1/roles/1") && l.includes("u-1"))).toBe(true);
    expect(lines.some((l) => l.includes("401"))).toBe(true);
    expect(lines.join("\n")).not.toContain("token=abc");
    expect(lines.join("\n")).not.toContain("secret=1");
  });
});


describe("describeDatabaseError", () => {
  it("keeps the class and code of a Prisma error but never its message", () => {
    const error = Object.assign(new Error("Unique constraint failed on users_email_key (email)=(victim@example.test)"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002"
    });
    const text = describeDatabaseError(error)!;
    expect(text).toContain("PrismaClientKnownRequestError");
    expect(text).toContain("P2002");
    expect(text).not.toContain("victim");
  });

  it("covers a raw pg error and ignores ordinary errors", () => {
    const pgError = Object.assign(new Error('duplicate key value (a)=(secret)'), { code: "23505", severity: "ERROR" });
    expect(describeDatabaseError(pgError)).not.toContain("secret");
    expect(describeDatabaseError(new Error("boom"))).toBeUndefined();
    expect(describeDatabaseError("text")).toBeUndefined();
  });
});

describe("AllExceptionsFilter logging (merge)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not log a body-parser 4xx as a mapped database error", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const tooLarge = Object.assign(new Error("request entity too large"), { status: 413, type: "entity.too.large" });
    expect(run(tooLarge).status).toBe(413);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("Database error mapped");
  });

  it("logs a mapped database error by class and code only", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const error = Object.assign(new Error("Unique constraint failed (email)=(victim@example.test)"), { name: "PrismaClientKnownRequestError", code: "P2002" });
    expect(run(error).status).toBe(409);
    const text = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("Database error mapped to HTTP 409");
    expect(text).toContain("P2002");
    expect(text).not.toContain("victim");
  });
});
