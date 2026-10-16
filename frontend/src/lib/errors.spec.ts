import { describe, expect, it } from "vitest";
import { ApiError, safeErrorCode } from "./api";
import { errorText, retryAfterOf } from "./errors";

const pick = (arabic: string, english: string) => `${arabic}|${english}`;
const tr = <T,>(value: T): T => (typeof value === "string" ? (`tr:${value}` as T) : value);

describe("retryAfterOf", () => {
  it("uses the server's Retry-After for a 429 and 30 seconds when it sent none", () => {
    expect(retryAfterOf(new ApiError(429, "slow down", 12))).toBe(12);
    expect(retryAfterOf(new ApiError(429, "slow down"))).toBe(30);
  });
  it("ignores other statuses and non-API errors", () => {
    expect(retryAfterOf(new ApiError(503, "down", 5))).toBeUndefined();
    expect(retryAfterOf(new Error("boom"))).toBeUndefined();
    expect(retryAfterOf(undefined)).toBeUndefined();
  });
});

describe("errorText", () => {
  it("falls back for anything that is not an ApiError", () => {
    expect(errorText(new Error("x"), pick, tr)).toBe("تعذر إكمال الطلب.|The request could not be completed.");
    expect(errorText("nope", pick, tr, { fallback: "F" })).toBe("F");
  });
  it("maps status families to fixed sentences without leaking server text", () => {
    expect(errorText(new ApiError(0, "Failed to fetch"), pick, tr)).toContain("Could not reach the server");
    expect(errorText(new ApiError(403, "Forbidden resource"), pick, tr)).toContain("permission to do this");
    expect(errorText(new ApiError(429, "ThrottlerException"), pick, tr)).toContain("Too many attempts");
    expect(errorText(new ApiError(500, "SELECT * FROM users"), pick, tr)).toContain("Something went wrong on our side");
  });
  it("uses the wrong-secret text for 401 and keeps server text only when asked", () => {
    expect(errorText(new ApiError(401, "Invalid credentials"), pick, tr, { wrongSecret: "W" })).toBe("W");
    expect(errorText(new ApiError(401, "Invalid credentials"), pick, tr, { serverTextFor401: true })).toBe("tr:Invalid credentials");
    expect(errorText(new ApiError(401, "Invalid credentials"), pick, tr)).toContain("Your session has ended");
  });
  it("passes server rule text for 400, 409 and 422 through the translator", () => {
    expect(errorText(new ApiError(422, "email must be an email"), pick, tr)).toBe("tr:email must be an email");
    expect(errorText(new ApiError(409, ""), pick, tr, { fallback: "F" })).toBe("F");
  });
  it("passes unknown 4xx text through the translator", () => {
    expect(errorText(new ApiError(404, "Not here"), pick, tr)).toBe("tr:Not here");
  });
});

describe("safeErrorCode", () => {
  it("keeps lower case and upper case machine codes", () => {
    expect(safeErrorCode("mfa_enrollment_required")).toBe("mfa_enrollment_required");
    expect(safeErrorCode("BOOKING_EXPIRED")).toBe("BOOKING_EXPIRED");
    expect(safeErrorCode("Booking_Pending_Limit2")).toBe("Booking_Pending_Limit2");
  });
  it("drops anything that is not a plain code", () => {
    for (const bad of [undefined, null, 42, "", "1ABC", "has space", "a-b", "<script>", "x".repeat(65), "الرمز"]) expect(safeErrorCode(bad)).toBeUndefined();
    expect(safeErrorCode("x".repeat(64))).toBe("x".repeat(64));
  });
});
