import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { corsOptions, noStoreMiddleware, swaggerEnabled, trustProxySetting } from "./app.setup.js";

describe("trustProxySetting", () => {
  it("maps the supported forms", () => {
    expect(trustProxySetting(undefined)).toBe(false);
    expect(trustProxySetting("false")).toBe(false);
    expect(trustProxySetting("true")).toBe(1);
    expect(trustProxySetting("2")).toBe(2);
    expect(trustProxySetting("10.0.0.0/8, loopback")).toEqual(["10.0.0.0/8", "loopback"]);
  });

  it("rejects values Express would misread", () => {
    expect(() => trustProxySetting("yes")).toThrow("TRUST_PROXY");
    expect(() => trustProxySetting("11")).toThrow("TRUST_PROXY");
    expect(() => trustProxySetting("*")).toThrow("TRUST_PROXY");
  });
});

describe("corsOptions", () => {
  it("keeps the local default outside production only", () => {
    expect(corsOptions(undefined, false)).toEqual({ origin: ["http://localhost:3001"], credentials: true });
    expect(corsOptions(undefined, true)).toEqual({ origin: false, credentials: false });
  });

  it("accepts exact https origins in production", () => {
    expect(corsOptions("https://app.example.com, https://admin.example.com", true).origin).toEqual([
      "https://app.example.com",
      "https://admin.example.com"
    ]);
  });

  it("rejects wildcard, paths and plain http in production", () => {
    expect(() => corsOptions("*", true)).toThrow("CORS_ORIGINS");
    expect(() => corsOptions("*", false)).toThrow("CORS_ORIGINS");
    expect(() => corsOptions("https://app.example.com/", true)).toThrow("bare origin");
    expect(() => corsOptions("http://localhost:3001", true)).toThrow("https");
  });

  it("enables credentials (refresh cookie) only together with an explicit origin list, never with none or a wildcard", () => {
    expect(corsOptions("https://app.example.com", true).credentials).toBe(true);
    expect(corsOptions(undefined, true)).toEqual({ origin: false, credentials: false });
    expect(() => corsOptions("*", false)).toThrow("CORS_ORIGINS");
  });
});

describe("swaggerEnabled", () => {
  it("is off in production unless explicitly enabled", () => {
    expect(swaggerEnabled(undefined, true)).toBe(false);
    expect(swaggerEnabled("true", true)).toBe(true);
    expect(swaggerEnabled(undefined, false)).toBe(true);
    expect(swaggerEnabled("false", false)).toBe(false);
    expect(() => swaggerEnabled("1", true)).toThrow("SWAGGER_ENABLED");
  });
});

describe("noStoreMiddleware", () => {
  const run = (path: string): { headers: Record<string, string>; flagged: boolean } => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as unknown as Response;
    noStoreMiddleware("api/v1")({ path } as unknown as Request, res, () => undefined);
    const flagged = Object.getOwnPropertySymbols(res).length > 0;
    return { headers, flagged };
  };
  it("sets no-store on API-prefix paths, except /docs and outside the prefix", () => {
    expect(run("/api/v1/services").headers).toEqual({ "Cache-Control": "no-store", Pragma: "no-cache" });
    expect(run("/api/v1/docs").headers).toEqual({});
    expect(run("/api/v1/docs/json").headers).toEqual({});
    expect(run("/other").headers).toEqual({});
  });
  it("marks only /auth/* responses as uncompressible", () => {
    expect(run("/api/v1/auth/login").flagged).toBe(true);
    expect(run("/api/v1/services").flagged).toBe(false);
  });
});
