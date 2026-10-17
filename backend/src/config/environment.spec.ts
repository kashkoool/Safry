import { describe, expect, it } from "vitest";
import { isProductionLike, validateEnvironment } from "./environment.js";

const valid = {
  DATABASE_URL: "postgresql://safry:password@localhost:5432/safry",
  JWT_ACCESS_SECRET: "a-secure-test-secret-with-32-characters"
};

describe("validateEnvironment", () => {
  it("applies safe defaults", () => {
    expect(validateEnvironment(valid)).toMatchObject({
      PORT: 3000,
      JWT_ACCESS_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 30,
      SESSION_IDLE_TIMEOUT_MINUTES: 15
    });
  });

  it("rejects a short JWT secret", () => {
    expect(() => validateEnvironment({ ...valid, JWT_ACCESS_SECRET: "short" })).toThrow("JWT_ACCESS_SECRET");
  });

  it("rejects placeholder JWT secrets, including the exact value shipped in the example files", () => {
    for (const secret of [
      "CHANGE_ME_GENERATE_WITH_openssl_rand_base64_48",
      "replace-with-at-least-32-random-characters",
      "please-change-me-this-is-long-enough-1234"
    ])
      expect(() => validateEnvironment({ ...valid, JWT_ACCESS_SECRET: secret })).toThrow("placeholder");
  });

  it("rejects a placeholder MFA encryption key", () => {
    expect(() => validateEnvironment({ ...valid, MFA_ENCRYPTION_KEY: "CHANGE_ME_GENERATE_WITH_openssl_rand_base64_48" })).toThrow("MFA_ENCRYPTION_KEY");
  });

  it("rejects an invalid port", () => {
    expect(() => validateEnvironment({ ...valid, PORT: "70000" })).toThrow("PORT is invalid");
  });

  it("rejects an invalid session idle timeout", () => {
    expect(() => validateEnvironment({ ...valid, SESSION_IDLE_TIMEOUT_MINUTES: "0" })).toThrow("SESSION_IDLE_TIMEOUT_MINUTES");
  });

  it("applies lockout defaults and validates the lockout policy", () => {
    expect(validateEnvironment(valid)).toMatchObject({ LOGIN_MAX_ATTEMPTS: 5, LOGIN_LOCKOUT_MINUTES: 15 });
    expect(validateEnvironment({ ...valid, LOGIN_MAX_ATTEMPTS: "3", LOGIN_LOCKOUT_MINUTES: "60" })).toMatchObject({
      LOGIN_MAX_ATTEMPTS: 3,
      LOGIN_LOCKOUT_MINUTES: 60
    });
    for (const value of ["2", "21", "abc", "5.5"]) expect(() => validateEnvironment({ ...valid, LOGIN_MAX_ATTEMPTS: value })).toThrow("LOGIN_MAX_ATTEMPTS");
    for (const value of ["yes", "1", "TRUE"]) expect(() => validateEnvironment({ ...valid, LOGIN_PORTAL_REQUIRED: value })).toThrow("LOGIN_PORTAL_REQUIRED");
    expect(() => validateEnvironment({ ...valid, LOGIN_PORTAL_REQUIRED: "true" })).not.toThrow();
    for (const value of ["0", "1441", "x"]) expect(() => validateEnvironment({ ...valid, LOGIN_LOCKOUT_MINUTES: value })).toThrow("LOGIN_LOCKOUT_MINUTES");
  });

  it("never lets row-level security be switched off outside development and tests", () => {
    for (const env of ["production", "staging", undefined])
      expect(() => validateEnvironment({ ...valid, MFA_ENCRYPTION_KEY: "unit-test-mfa-key-not-the-jwt-secret-0123456789", NODE_ENV: env, DATABASE_RLS: "off" })).toThrow("DATABASE_RLS=off");
    expect(() => validateEnvironment({ ...valid, MFA_ENCRYPTION_KEY: "unit-test-mfa-key-not-the-jwt-secret-0123456789", NODE_ENV: "production", DATABASE_RLS: "on", MAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_abcdabcdabcdabcdabcdabcdabcd", MAIL_FROM: "Safry <no-reply@mail.safry.test>", APP_BASE_URL: "https://app.safry.test" })).not.toThrow();
  });

  it("validates the row-level-security mode, pool size and MFA key", () => {
    for (const mode of ["on", "auto"]) expect(() => validateEnvironment({ ...valid, DATABASE_RLS: mode })).not.toThrow();
    for (const env of ["development", "test"])
      expect(() => validateEnvironment({ ...valid, NODE_ENV: env, DATABASE_RLS: "off" })).not.toThrow();
    expect(() => validateEnvironment({ ...valid, DATABASE_RLS: "maybe" })).toThrow("DATABASE_RLS");
    expect(validateEnvironment({ ...valid, DATABASE_POOL_MAX: "7" })).toMatchObject({ DATABASE_POOL_MAX: 7 });
    expect(validateEnvironment(valid)).not.toHaveProperty("DATABASE_POOL_MAX");
    expect(() => validateEnvironment({ ...valid, DATABASE_POOL_MAX: "0" })).toThrow("DATABASE_POOL_MAX");
    expect(() => validateEnvironment({ ...valid, MFA_ENCRYPTION_KEY: "short" })).toThrow("MFA_ENCRYPTION_KEY");
    expect(() => validateEnvironment({ ...valid, MFA_ENCRYPTION_KEY: "k".repeat(32) })).toThrow("entropy");
    expect(() => validateEnvironment({ ...valid, MFA_ENCRYPTION_KEY: "unit-test-only-mfa-key-not-a-secret-0123456789" })).not.toThrow();
  });

  it("rejects a typo in NODE_ENV instead of silently changing behaviour", () => {
    expect(() => validateEnvironment({ ...valid, NODE_ENV: "prod" })).toThrow("NODE_ENV");
    for (const env of ["development", "test"]) expect(() => validateEnvironment({ ...valid, NODE_ENV: env })).not.toThrow();
  });

  describe("database TLS in production", () => {
    const production = { ...valid, NODE_ENV: "production", MFA_ENCRYPTION_KEY: "another-secure-test-key-0123456789abcdef!", MAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_abcdabcdabcdabcdabcdabcdabcd", MAIL_FROM: "Safry <no-reply@mail.safry.test>", APP_BASE_URL: "https://app.safry.test" };
    it("requires sslmode for a routable database host", () => {
      const remote = "postgresql://u:p@db.example.internal:5432/safry";
      expect(() => validateEnvironment({ ...production, DATABASE_URL: remote })).toThrow("sslmode");
      expect(() => validateEnvironment({ ...production, DATABASE_URL: `${remote}?sslmode=disable` })).toThrow("sslmode");
      expect(() => validateEnvironment({ ...production, DATABASE_URL: `${remote}?sslmode=require` })).not.toThrow();
      expect(() => validateEnvironment({ ...production, DATABASE_URL: remote, DATABASE_ALLOW_PLAINTEXT: "true" })).not.toThrow();
    });
    it("accepts the internal compose host without TLS", () => {
      expect(() => validateEnvironment({ ...production, DATABASE_URL: "postgresql://u:p@postgres:5432/safry" })).not.toThrow();
      expect(() => validateEnvironment({ ...production, DATABASE_URL: "postgresql://u:p@localhost:5432/safry" })).not.toThrow();
    });
  });
  it("validates the mail retry settings", () => {
    expect(validateEnvironment({ ...valid, MAIL_RETRY_ATTEMPTS: "1", MAIL_RETRY_BASE_MS: "0" })).toMatchObject({ MAIL_RETRY_ATTEMPTS: 1, MAIL_RETRY_BASE_MS: 0 });
    for (const attempts of ["0", "6", "x", "1.5"]) expect(() => validateEnvironment({ ...valid, MAIL_RETRY_ATTEMPTS: attempts })).toThrow("MAIL_RETRY_ATTEMPTS");
    for (const base of ["-1", "30001", "x"]) expect(() => validateEnvironment({ ...valid, MAIL_RETRY_BASE_MS: base })).toThrow("MAIL_RETRY_BASE_MS");
  });
  it("validates the mail budget settings", () => {
    expect(validateEnvironment({ ...valid, MAIL_BUDGET_RESET_PER_HOUR: "20", MAIL_BUDGET_RESET_PER_DAY: "80", MAIL_ADDRESS_RESET_PER_DAY: "5" })).toMatchObject({ MAIL_BUDGET_RESET_PER_HOUR: 20, MAIL_BUDGET_RESET_PER_DAY: 80, MAIL_ADDRESS_RESET_PER_DAY: 5 });
    for (const pool of ["REGISTRATION", "RESET", "SECURITY"])
      for (const v of ["0", "-1", "x", "1.5"]) {
        expect(() => validateEnvironment({ ...valid, [`MAIL_BUDGET_${pool}_PER_HOUR`]: v })).toThrow(`MAIL_BUDGET_${pool}_PER_HOUR`);
        expect(() => validateEnvironment({ ...valid, [`MAIL_BUDGET_${pool}_PER_DAY`]: v })).toThrow(`MAIL_BUDGET_${pool}_PER_DAY`);
      }
    for (const scope of ["REGISTRATION", "RESET"])
      for (const v of ["0", "-1", "x", "100001"]) expect(() => validateEnvironment({ ...valid, [`MAIL_ADDRESS_${scope}_PER_DAY`]: v })).toThrow(`MAIL_ADDRESS_${scope}_PER_DAY`);
    for (const v of ["0", "-1", "x", "1001"]) expect(() => validateEnvironment({ ...valid, MAIL_RECIPIENT_RESET_PER_DAY: v })).toThrow("MAIL_RECIPIENT_RESET_PER_DAY");
    // hourly above the daily limit of the same pool, set or defaulted
    expect(() => validateEnvironment({ ...valid, MAIL_BUDGET_RESET_PER_HOUR: "200" })).toThrow("MAIL_BUDGET_RESET_PER_HOUR must not exceed MAIL_BUDGET_RESET_PER_DAY");
    expect(() => validateEnvironment({ ...valid, MAIL_BUDGET_REGISTRATION_PER_DAY: "5" })).toThrow("MAIL_BUDGET_REGISTRATION_PER_HOUR must not exceed");
  });
});

describe("staging gets production-grade defaults unless it explicitly opts out", () => {
  const stagingMail = { MAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_abcdabcdabcdabcdabcdabcdabcd", MAIL_FROM: "Safry <no-reply@mail.safry.test>", APP_BASE_URL: "https://staging.safry.test" };
  const mfaKey = { MFA_ENCRYPTION_KEY: "unit-test-mfa-key-not-the-jwt-secret-0123456789" };

  it("decides production-likeness in one place", () => {
    expect(isProductionLike("production", undefined)).toBe(true);
    expect(isProductionLike("production", "true")).toBe(true);
    expect(isProductionLike("staging", undefined)).toBe(true);
    expect(isProductionLike("staging", "false")).toBe(true);
    expect(isProductionLike("staging", "true")).toBe(false);
    expect(isProductionLike("development", undefined)).toBe(false);
    expect(isProductionLike("test", undefined)).toBe(false);
    expect(isProductionLike(undefined, undefined)).toBe(false);
  });

  it("refuses console mail, a missing MFA key and a plaintext remote database on staging", () => {
    expect(() => validateEnvironment({ ...valid, ...mfaKey, NODE_ENV: "staging", MAIL_TRANSPORT: "console" })).toThrow("MAIL_TRANSPORT=console");
    expect(() => validateEnvironment({ ...valid, ...stagingMail, NODE_ENV: "staging" })).toThrow("MFA_ENCRYPTION_KEY is required");
    expect(() => validateEnvironment({ ...valid, ...mfaKey, ...stagingMail, NODE_ENV: "staging", DATABASE_URL: "postgresql://u:p@db.example.com:5432/safry" })).toThrow("sslmode");
    expect(() => validateEnvironment({ ...valid, ...mfaKey, ...stagingMail, NODE_ENV: "staging" })).not.toThrow();
  });

  it("allows development defaults on staging only with the explicit opt-in, and never in production", () => {
    expect(() => validateEnvironment({ ...valid, NODE_ENV: "staging", MAIL_TRANSPORT: "console", ALLOW_NON_PRODUCTION_DEFAULTS: "true" })).not.toThrow();
    expect(() => validateEnvironment({ ...valid, NODE_ENV: "production", ...mfaKey, ...stagingMail, ALLOW_NON_PRODUCTION_DEFAULTS: "true" })).toThrow("only valid with NODE_ENV=staging");
    expect(() => validateEnvironment({ ...valid, NODE_ENV: "development", ALLOW_NON_PRODUCTION_DEFAULTS: "true" })).toThrow("only valid with NODE_ENV=staging");
    expect(() => validateEnvironment({ ...valid, NODE_ENV: "staging", ALLOW_NON_PRODUCTION_DEFAULTS: "yes" })).toThrow("true or false");
  });

  it("refuses the loose mode on a public https host unless a second flag acknowledges it", () => {
    const loose = { ...valid, NODE_ENV: "staging", MAIL_TRANSPORT: "console", ALLOW_NON_PRODUCTION_DEFAULTS: "true" };
    expect(() => validateEnvironment({ ...loose, APP_BASE_URL: "https://staging.example.com" })).toThrow("ALLOW_NON_PRODUCTION_ON_PUBLIC_HOST");
    expect(() => validateEnvironment({ ...loose, CORS_ORIGINS: "http://localhost:3001,https://app.example.com" })).toThrow("ALLOW_NON_PRODUCTION_ON_PUBLIC_HOST");
    expect(() => validateEnvironment({ ...loose, APP_BASE_URL: "https://staging.example.com", ALLOW_NON_PRODUCTION_ON_PUBLIC_HOST: "false" })).toThrow("public host");
    expect(() => validateEnvironment({ ...loose, APP_BASE_URL: "https://staging.example.com", ALLOW_NON_PRODUCTION_ON_PUBLIC_HOST: "true" })).not.toThrow();
  });

  it("keeps the loose mode working for local hosts and plain http, and does not touch strict staging", () => {
    const loose = { ...valid, NODE_ENV: "staging", MAIL_TRANSPORT: "console", ALLOW_NON_PRODUCTION_DEFAULTS: "true" };
    for (const base of ["http://localhost:3001", "https://localhost:3001", "https://127.0.0.1:8443", "https://app.localhost", "http://web:8080"])
      expect(() => validateEnvironment({ ...loose, APP_BASE_URL: base })).not.toThrow();
    expect(() => validateEnvironment({ ...loose, CORS_ORIGINS: "http://127.0.0.1:8080" })).not.toThrow();
    expect(() => validateEnvironment({ ...valid, ...mfaKey, ...stagingMail, NODE_ENV: "staging" })).not.toThrow();
  });

  it("rejects NODE_ENV values it does not know, so a typo can not select development defaults", () => {
    for (const value of ["prod", "Production", "stage", ""]) expect(() => validateEnvironment({ ...valid, NODE_ENV: value })).toThrow("NODE_ENV must be one of");
  });
});
