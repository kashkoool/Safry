import { describe, expect, it } from "vitest";
import { validateEnvironment } from "./environment.js";

const jwt = "Jx9-k2Lq8vNw4rT7yUe1oPa5sDf3gHz6"; // fake, test only
const mfa = "M7q-Wd2xRt9vBn4kLp8sEz1aYc6uHj3f"; // fake, test only
const base = { DATABASE_URL: "postgresql://safry:password@localhost:5432/safry", JWT_ACCESS_SECRET: jwt };

describe("validateEnvironment secrets", () => {
  it("rejects a long but low-entropy JWT secret", () => {
    for (const secret of ["a".repeat(48), "abababababababababababababababab", "01234567890123456789012345678901"])
      expect(() => validateEnvironment({ ...base, JWT_ACCESS_SECRET: secret })).toThrow("JWT_ACCESS_SECRET");
  });

  it("requires a dedicated MFA key in production", () => {
    expect(() => validateEnvironment({ ...base, NODE_ENV: "production" })).toThrow("MFA_ENCRYPTION_KEY");
    expect(validateEnvironment({ ...base, NODE_ENV: "production", MFA_ENCRYPTION_KEY: mfa, MAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_abcdabcdabcdabcdabcdabcdabcd", MAIL_FROM: "Safry <no-reply@mail.safry.test>", APP_BASE_URL: "https://app.safry.test" })).toMatchObject({ MFA_ENCRYPTION_KEY: mfa });
  });

  it("refuses an MFA key equal to the JWT secret or of low entropy", () => {
    expect(() => validateEnvironment({ ...base, MFA_ENCRYPTION_KEY: jwt })).toThrow("MFA_ENCRYPTION_KEY");
    expect(() => validateEnvironment({ ...base, MFA_ENCRYPTION_KEY: "b".repeat(40) })).toThrow("MFA_ENCRYPTION_KEY");
  });

  it("validates the absolute session lifetime", () => {
    expect(validateEnvironment(base)).toMatchObject({ SESSION_ABSOLUTE_TIMEOUT_HOURS: 24 });
    expect(validateEnvironment({ ...base, SESSION_ABSOLUTE_TIMEOUT_HOURS: "8" })).toMatchObject({ SESSION_ABSOLUTE_TIMEOUT_HOURS: 8 });
    for (const value of ["0", "721", "1.5", "x"])
      expect(() => validateEnvironment({ ...base, SESSION_ABSOLUTE_TIMEOUT_HOURS: value })).toThrow("SESSION_ABSOLUTE_TIMEOUT_HOURS");
  });
});

describe("validateEnvironment transactional e-mail", () => {
  const prod = { ...base, NODE_ENV: "production", MFA_ENCRYPTION_KEY: mfa, APP_BASE_URL: "https://app.safry.test" };
  const resend = { MAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_abcdabcdabcdabcdabcdabcdabcd", MAIL_FROM: "Safry <no-reply@mail.safry.test>" };
  it("defaults to the console transport outside production and needs no key", () => {
    expect(() => validateEnvironment(base)).not.toThrow();
    expect(() => validateEnvironment({ ...base, MAIL_TRANSPORT: "console" })).not.toThrow();
  });
  it("refuses the console transport in production", () => {
    expect(() => validateEnvironment({ ...prod, MAIL_TRANSPORT: "console" })).toThrow("console");
  });
  it("production without MAIL_TRANSPORT means resend and fails fast on a missing or placeholder key", () => {
    expect(() => validateEnvironment(prod)).toThrow("RESEND_API_KEY");
    expect(() => validateEnvironment({ ...prod, ...resend, RESEND_API_KEY: "CHANGE_ME_RESEND_API_KEY" })).toThrow("RESEND_API_KEY");
    expect(() => validateEnvironment({ ...prod, ...resend, RESEND_API_KEY: "re_short" })).toThrow("RESEND_API_KEY");
    expect(() => validateEnvironment({ ...prod, ...resend, RESEND_API_KEY: "re_abcdabcdabcdabcd abcdabcdabcd" })).toThrow("whitespace");
    expect(() => validateEnvironment({ ...prod, ...resend })).not.toThrow();
  });
  it("requires a real sender and a bare https APP_BASE_URL in production", () => {
    for (const from of [undefined, "CHANGE_ME_MAIL_FROM", "not an address", "Safry <no-reply@example.com>"])
      expect(() => validateEnvironment({ ...prod, ...resend, MAIL_FROM: from })).toThrow("MAIL_FROM");
    expect(() => validateEnvironment({ ...prod, ...resend, APP_BASE_URL: undefined })).toThrow("APP_BASE_URL");
    for (const url of ["http://app.safry.test", "https://app.safry.test/app", "not a url"])
      expect(() => validateEnvironment({ ...prod, ...resend, APP_BASE_URL: url })).toThrow("APP_BASE_URL");
  });
  it("rejects an unknown transport", () => {
    expect(() => validateEnvironment({ ...base, MAIL_TRANSPORT: "smtp" })).toThrow("MAIL_TRANSPORT");
  });
});
