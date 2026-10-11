import { describe, expect, it } from "vitest";
import { SecretBox } from "./secret-box.js";
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUri, totpStep, verifyTotp } from "./totp.js";

// RFC 4226 / RFC 6238 test secret: the ASCII string "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("totp", () => {
  it("encodes the RFC secret as base32 and decodes it back", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_SECRET).toString()).toBe("12345678901234567890");
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").toString()).toBe("12345678901234567890");
    expect(() => base32Decode("not*base32")).toThrow();
  });

  it("matches the RFC 4226 HOTP test vectors", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it("matches the RFC 6238 TOTP test vectors (last six digits, SHA-1)", () => {
    const vectors: Array<[number, string]> = [
      [59, "287082"],
      [1_111_111_109, "081804"],
      [1_234_567_890, "005924"],
      [2_000_000_000, "279037"]
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(RFC_SECRET, totpStep(seconds * 1000))).toBe(code);
      expect(verifyTotp(RFC_SECRET, code, seconds * 1000, 0)).toBe(totpStep(seconds * 1000));
    }
  });

  it("tolerates one step of clock drift but not more", () => {
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now)).toBeNull();
  });

  it("rejects malformed codes", () => {
    for (const code of ["", "12345", "1234567", "abcdef", "12 456", "١٢٣٤٥٦"]) expect(verifyTotp(RFC_SECRET, code)).toBeNull();
  });

  it("generates 160-bit secrets and a provisioning URI", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(secret).not.toBe(generateTotpSecret());
    const uri = otpauthUri(secret, "user@example.test");
    expect(uri.startsWith("otpauth://totp/Safry%20Platform%3Auser%40example.test?")).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("period=30");
    expect(uri).toContain("digits=6");
  });
});

describe("SecretBox", () => {
  it("round-trips a secret with a random nonce", () => {
    const box = new SecretBox("key material");
    const first = box.seal("JBSWY3DPEHPK3PXP");
    expect(first).toMatch(/^v1\./);
    expect(first).not.toContain("JBSWY3DPEHPK3PXP");
    expect(box.open(first)).toBe("JBSWY3DPEHPK3PXP");
    expect(box.seal("JBSWY3DPEHPK3PXP")).not.toBe(first);
  });

  it("detects tampering, truncation and a wrong key", () => {
    const sealed = new SecretBox("key one").seal("secret");
    expect(() => new SecretBox("key two").open(sealed)).toThrow();
    const parts = sealed.split(".");
    expect(() => new SecretBox("key one").open([parts[0], parts[1], parts[2], Buffer.from("tampered").toString("base64url")].join("."))).toThrow();
    expect(() => new SecretBox("key one").open("v1.only")).toThrow(/Unsupported/);
    expect(() => new SecretBox("key one").open("v9.a.b.c")).toThrow(/Unsupported/);
  });
});
