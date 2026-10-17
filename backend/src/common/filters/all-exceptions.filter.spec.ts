import { ForbiddenException, Logger, UnauthorizedException, type ArgumentsHost } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter, describeDatabaseError } from "./all-exceptions.filter.js";
import { ServiceBusyException, retryAfterWithJitter } from "./service-busy.exception.js";


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

  it("passes a stable lower-snake-case code through and drops anything else", () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const ok = run(new ForbiddenException({ code: "mfa_enrollment_required", message: "m" })).body as { code?: string };
    expect(ok.code).toBe("mfa_enrollment_required");
    expect((run(new ForbiddenException({ code: "<script>", message: "m" })).body as { code?: string }).code).toBeUndefined();
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

describe("AllExceptionsFilter overload answers", () => {
  afterEach(() => vi.restoreAllMocks());

  function runWithHeaders(error: unknown): { status: number; headers: Record<string, string>; body: Record<string, unknown> } {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const headers: Record<string, string> = {};
    const host = {
      switchToHttp: (): unknown => ({
        getResponse: (): unknown => ({ status, setHeader: (name: string, value: string) => (headers[name] = value) }),
        getRequest: (): unknown => ({ method: "POST", originalUrl: "/api/v1/auth/login" })
      })
    } as unknown as ArgumentsHost;
    new AllExceptionsFilter().catch(error, host);
    return { status: status.mock.calls[0]?.[0] as number, headers, body: json.mock.calls[0]?.[0] as Record<string, unknown> };
  }

  it("answers 503 with Retry-After for a pool-wait timeout and shows no database detail", () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const raised = { name: "PrismaClientKnownRequestError", code: "P2028", message: "Transaction API error: Unable to start a transaction in the given time. SELECT secret_table" };
    const { status, headers, body } = runWithHeaders(raised);
    expect(status).toBe(503);
    expect(Number(headers["Retry-After"])).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("secret_table");
  });

  it("sets Retry-After for a refused hash queue too", () => {
    const { status, headers } = runWithHeaders(new ServiceBusyException());
    expect(status).toBe(503);
    expect(["2", "3", "4"]).toContain(headers["Retry-After"]);
  });

  it("spreads Retry-After over base..base+2 whole seconds", () => {
    expect(retryAfterWithJitter(2, () => 0)).toBe(2);
    expect(retryAfterWithJitter(2, () => 0.5)).toBe(3);
    expect(retryAfterWithJitter(2, () => 0.999)).toBe(4);
    const seen = new Set(Array.from({ length: 200 }, () => retryAfterWithJitter(2)));
    expect([...seen].sort()).toEqual([2, 3, 4]);
  });

  it("logs the error class (not the message) of a mapped pool timeout that carries no database code", () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const raised = new Error("timeout exceeded when trying to connect");
    expect(runWithHeaders(raised).status).toBe(503);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("Error (message withheld)");
    expect(line).not.toContain("timeout exceeded");
  });

  it("sets no Retry-After on other statuses", () => {
    expect(runWithHeaders(new ForbiddenException("x")).headers["Retry-After"]).toBeUndefined();
  });
});
