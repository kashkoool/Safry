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
    expect(validateEnvironment({ ...base, NODE_ENV: "production", MFA_ENCRYPTION_KEY: mfa })).toMatchObject({ MFA_ENCRYPTION_KEY: mfa });
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
