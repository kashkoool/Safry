import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { assertBrowserRequest, clearRefreshCookie, clientKind, cookieSettings, readCookie, setRefreshCookie } from "./refresh-cookie.js";

const request = (headers: Record<string, string>, protocol = "https"): Request =>
  ({ header: (name: string) => headers[name.toLowerCase()], protocol }) as unknown as Request;

function capture(): { res: Response; calls: Array<{ kind: string; name: string; value?: string; options: Record<string, unknown> }> } {
  const calls: Array<{ kind: string; name: string; value?: string; options: Record<string, unknown> }> = [];
  const res = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => calls.push({ kind: "set", name, value, options }),
    clearCookie: (name: string, options: Record<string, unknown>) => calls.push({ kind: "clear", name, options })
  } as unknown as Response;
  return { res, calls };
}

describe("cookieSettings", () => {
  it("uses the __Secure- prefix and Secure in production, plain name and no Secure otherwise; always scoped to /auth", () => {
    expect(cookieSettings("api/v1", true)).toEqual({ name: "__Secure-safry_rt", path: "/api/v1/auth", secure: true });
    expect(cookieSettings("/api/v1/", false)).toEqual({ name: "safry_rt", path: "/api/v1/auth", secure: false });
  });
});

describe("setRefreshCookie / clearRefreshCookie", () => {
  it("sets HttpOnly + SameSite=Strict + Secure(prod) + path, Max-Age = remaining lifetime", () => {
    const { res, calls } = capture();
    setRefreshCookie(res, cookieSettings("api/v1", true), "tok", new Date(1_000_000 + 3_600_000), 1_000_000);
    expect(calls[0]).toMatchObject({
      kind: "set",
      name: "__Secure-safry_rt",
      value: "tok",
      options: { httpOnly: true, secure: true, sameSite: "strict", path: "/api/v1/auth", maxAge: 3_600_000 }
    });
  });

  it("never sets a negative Max-Age and clears with the same flags", () => {
    const { res, calls } = capture();
    const settings = cookieSettings("api/v1", false);
    setRefreshCookie(res, settings, "tok", new Date(0), 5_000);
    clearRefreshCookie(res, settings);
    expect(calls[0]!.options["maxAge"]).toBe(0);
    expect(calls[1]).toMatchObject({ kind: "clear", options: { httpOnly: true, secure: false, sameSite: "strict", path: "/api/v1/auth" } });
  });
});

describe("readCookie", () => {
  it("finds the named cookie among others and ignores empty or malformed values", () => {
    expect(readCookie("a=1; safry_rt=abc_-9; b=2", "safry_rt")).toBe("abc_-9");
    expect(readCookie("xsafry_rt=1", "safry_rt")).toBeUndefined();
    expect(readCookie("safry_rt=", "safry_rt")).toBeUndefined();
    expect(readCookie("safry_rt=%E0%A4%A", "safry_rt")).toBeUndefined();
    expect(readCookie(undefined, "safry_rt")).toBeUndefined();
  });
  it("treats duplicate same-name cookies as an invalid request (cookie tossing), whichever comes first", () => {
    expect(() => readCookie("safry_rt=planted; safry_rt=real", "safry_rt")).toThrow(UnauthorizedException);
    expect(() => readCookie("safry_rt=real; safry_rt=planted", "safry_rt")).toThrow(UnauthorizedException);
    expect(() => readCookie("safry_rt=; safry_rt=real", "safry_rt")).toThrow(UnauthorizedException);
    expect(readCookie("other=1; other=2; safry_rt=real", "safry_rt")).toBe("real"); // only the refresh cookie name matters
  });
});

describe("clientKind", () => {
  it("is native only for an exact X-Client: mobile opt-in", () => {
    expect(clientKind(request({ "x-client": "mobile" }))).toBe("native");
    expect(clientKind(request({ "x-client": " Mobile " }))).toBe("native");
    expect(clientKind(request({ "x-client": "web" }))).toBe("web");
    expect(clientKind(request({}))).toBe("web");
  });
});

describe("assertBrowserRequest", () => {
  const csrf = { "x-requested-with": "XMLHttpRequest" };
  it("requires the custom header when asked", () => {
    expect(() => assertBrowserRequest(request({}), undefined, true, true)).toThrow(ForbiddenException);
    expect(() => assertBrowserRequest(request(csrf), undefined, true, true)).not.toThrow();
    expect(() => assertBrowserRequest(request({}), undefined, true, false)).not.toThrow();
  });
  it("refuses a foreign or null Origin, accepts configured and same-host origins and absent Origin", () => {
    const cors = "https://app.example.com";
    const host = "api.example.com";
    expect(() => assertBrowserRequest(request({ ...csrf, host, origin: "https://evil.example" }), cors, true, true)).toThrow(ForbiddenException);
    expect(() => assertBrowserRequest(request({ ...csrf, host, origin: "null" }), cors, true, true)).toThrow(ForbiddenException);
    expect(() => assertBrowserRequest(request({ ...csrf, host, origin: "https://app.example.com.evil.example" }), cors, true, true)).toThrow(ForbiddenException);
    expect(() => assertBrowserRequest(request({ ...csrf, host, origin: "https://app.example.com" }), cors, true, true)).not.toThrow();
    expect(() => assertBrowserRequest(request({ ...csrf, host, origin: "https://api.example.com" }), undefined, true, true)).not.toThrow();
    expect(() => assertBrowserRequest(request({ ...csrf, host }), undefined, true, true)).not.toThrow();
  });
  it("compares scheme, host and port: http://h is not https://h, port must match", () => {
    const host = "api.example.com";
    // TLS terminated by the proxy: Express reports protocol https only when TRUST_PROXY honours X-Forwarded-Proto.
    expect(() => assertBrowserRequest(request({ ...csrf, host, origin: "http://api.example.com" }, "https"), undefined, true, true)).toThrow(ForbiddenException);
    expect(() => assertBrowserRequest(request({ ...csrf, host, origin: "https://api.example.com" }, "http"), undefined, true, true)).toThrow(ForbiddenException);
    expect(() => assertBrowserRequest(request({ ...csrf, host, origin: "https://api.example.com:8443" }, "https"), undefined, true, true)).toThrow(ForbiddenException);
    expect(() => assertBrowserRequest(request({ ...csrf, host: "api.example.com:8443", origin: "https://api.example.com" }, "https"), undefined, true, true)).toThrow(ForbiddenException);
    expect(() => assertBrowserRequest(request({ ...csrf, host, origin: "https://api.example.com" }, "https"), undefined, true, true)).not.toThrow();
    expect(() => assertBrowserRequest(request({ ...csrf, host: "localhost:3001", origin: "http://localhost:3001" }, "http"), undefined, false, true)).not.toThrow();
    // A configured origin is matched as a whole string, scheme included.
    expect(() => assertBrowserRequest(request({ ...csrf, host, origin: "http://app.example.com" }, "https"), "https://app.example.com", true, true)).toThrow(ForbiddenException);
  });
});
