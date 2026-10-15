import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_MAX, PASSWORD_MIN, TOKEN_PATTERN, passwordStrength, takeFragmentToken } from "./credentials";

describe("TOKEN_PATTERN", () => {
  it("accepts url-safe tokens of 20 to 100 characters", () => {
    expect(TOKEN_PATTERN.test("a".repeat(20))).toBe(true);
    expect(TOKEN_PATTERN.test(`Ab_-9${"x".repeat(95)}`)).toBe(true);
  });
  it("rejects short, long, padded or non-url-safe tokens", () => {
    for (const value of ["a".repeat(19), "a".repeat(101), "a".repeat(20) + "=", "a".repeat(20) + " ", "ab+cd/".padEnd(25, "e"), ""]) {
      expect(TOKEN_PATTERN.test(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("passwordStrength", () => {
  it("reports short passwords below the minimum length", () => {
    expect(PASSWORD_MIN).toBe(12);
    expect(passwordStrength("Aa1!aaaaaaa")).toBe("short");
  });
  it("reports weak for low variety or few distinct characters", () => {
    expect(passwordStrength("aaaaaaaaaaaaaaaa")).toBe("weak");
    expect(passwordStrength("abcabcabcabc")).toBe("weak"); // 3 distinct characters
    expect(passwordStrength("abcdefghijklmnop")).toBe("weak"); // one character class
  });
  it("reports fair and strong by length and class count", () => {
    expect(passwordStrength("Abcdefgh1234")).toBe("fair");
    expect(passwordStrength("abcdefgh12345678")).toBe("fair"); // 16 chars but only 2 classes
    expect(passwordStrength("Abcdefgh1234!xyz")).toBe("strong");
    expect(passwordStrength("Abcdefgh12345678")).toBe("strong"); // 16 chars and 3 classes
  });
  it("never echoes the password and accepts the maximum length", () => {
    expect(PASSWORD_MAX).toBe(128);
    expect(["short", "weak", "fair", "strong"]).toContain(passwordStrength("Aa1!".repeat(32)));
  });
});

describe("takeFragmentToken", () => {
  const token = "Abcdefghij_klmnopqrstu-1";
  let replaceState: ReturnType<typeof vi.fn>;
  let location: { hash: string; pathname: string; search: string };

  beforeEach(() => {
    replaceState = vi.fn();
    location = { hash: "", pathname: "/reset", search: "?lang=en" };
    vi.stubGlobal("window", { location, history: { state: { s: 1 }, replaceState } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a valid token and strips the whole fragment from the address", () => {
    location.hash = `#token=${token}&other=1`;
    expect(takeFragmentToken()).toBe(token);
    expect(replaceState).toHaveBeenCalledWith({ s: 1 }, "", "/reset?lang=en");
  });

  it("returns null without touching history when there is no fragment", () => {
    expect(takeFragmentToken()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("returns null for an invalid token but still removes the fragment", () => {
    location.hash = "#token=short";
    expect(takeFragmentToken()).toBeNull();
    expect(replaceState).toHaveBeenCalledWith({ s: 1 }, "", "/reset?lang=en");
  });
});
