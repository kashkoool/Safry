import { describe, expect, it } from "vitest";
import { mailTransportName } from "./mail.config.js";

const cfg = (values: Record<string, string>): { get<T = string>(key: string): T | undefined } => ({ get: <T = string>(key: string): T | undefined => values[key] as T | undefined });

describe("mailTransportName by environment", () => {
  it("uses the real transport by default in production and staging, console only in development, tests or relaxed staging", () => {
    expect(mailTransportName(cfg({ NODE_ENV: "staging" }))).toBe("resend");
    expect(mailTransportName(cfg({ NODE_ENV: "staging", ALLOW_NON_PRODUCTION_DEFAULTS: "true" }))).toBe("console");
    expect(mailTransportName(cfg({ NODE_ENV: "development" }))).toBe("console");
    expect(mailTransportName(cfg({ NODE_ENV: "staging", MAIL_TRANSPORT: "console", ALLOW_NON_PRODUCTION_DEFAULTS: "true" }))).toBe("console");
  });
});
