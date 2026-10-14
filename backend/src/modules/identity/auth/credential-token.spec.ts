import { describe, expect, it } from "vitest";
import { TOKEN_PATTERN, hashToken, newToken, sameDigest } from "./credential-token.js";

describe("credential tokens", () => {
  it("are 32 random bytes in 43 URL-safe characters, never repeating", () => {
    const tokens = new Set(Array.from({ length: 500 }, newToken));
    expect(tokens.size).toBe(500);
    for (const token of tokens) {
      expect(token).toMatch(TOKEN_PATTERN);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    }
  });
  it("hash to a 64-character SHA-256 hex digest that differs from the token", () => {
    const token = newToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("compare in constant time and reject different, empty or malformed digests", () => {
    const digest = hashToken("x");
    expect(sameDigest(digest, digest)).toBe(true);
    expect(sameDigest(digest, hashToken("y"))).toBe(false);
    expect(sameDigest(digest, digest.slice(2))).toBe(false);
    expect(sameDigest("", "")).toBe(false);
    expect(sameDigest("zz", "zz")).toBe(false);
  });
  it("shape check rejects anything but 43 URL-safe characters", () => {
    for (const bad of ["", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}+`, `${"a".repeat(42)}=`, `${"a".repeat(42)} `]) expect(TOKEN_PATTERN.test(bad)).toBe(false);
  });
});
