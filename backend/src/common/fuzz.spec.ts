import { BadRequestException } from "@nestjs/common";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MoneyRangeError, fromMinorUnits, multiplyMinorUnits, serializeMoney, toMinorUnits } from "./money/money.js";
import { decodeCursor, encodeCursor } from "./pagination.js";
import { base32Decode, base32Encode, verifyTotp } from "./security/totp.js";
import { validateEnvironment } from "../config/environment.js";
import { escapeHtml, mailLocale, renderMail } from "../modules/mail/templates.js";

/** Property-based tests over code that handles untrusted input. Failures print a seed; replay with `fc.assert(..., { seed })`. */
const runs = { numRuns: Number(process.env["FUZZ_RUNS"] ?? 300) };

describe("cursor decoding", () => {
  it("never throws anything but BadRequestException for arbitrary text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (raw) => {
        try {
          decodeCursor(raw);
        } catch (error) {
          expect(error).toBeInstanceOf(BadRequestException);
        }
      }),
      runs
    );
  });
  it("round-trips every valid cursor", () => {
    fc.assert(
      fc.property(fc.date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2100-12-31T00:00:00Z"), noInvalidDate: true }), fc.uuid(), (createdAt, id) => {
        expect(decodeCursor(encodeCursor({ createdAt, id }))).toEqual({ createdAt, id });
      }),
      runs
    );
  });
});

describe("money", () => {
  it("accepts exactly the safe integers and round-trips them", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), (value) => {
        if (Number.isSafeInteger(value)) expect(fromMinorUnits(toMinorUnits(value)) === value).toBe(true); // -0 equals 0
        else expect(() => toMinorUnits(value)).toThrow(MoneyRangeError);
      }),
      runs
    );
  });
  it("multiplication is exact or throws MoneyRangeError, never a silently wrong number", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 60n }), fc.integer({ min: 0, max: 1_000_000 }), (first, factor) => {
        try {
          const result = multiplyMinorUnits(first, factor);
          expect(result).toBe(first * BigInt(factor));
        } catch (error) {
          expect(error).toBeInstanceOf(MoneyRangeError);
        }
      }),
      runs
    );
  });
  it("serialization never leaves a bigint behind or throws a foreign error", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }), (json, big) => {
        try {
          expect(JSON.stringify({ json: serializeMoney(json), big: serializeMoney(big) })).toBeTypeOf("string");
        } catch (error) {
          expect(error).toBeInstanceOf(MoneyRangeError);
        }
      }),
      runs
    );
  });
});

describe("two-factor codes", () => {
  it("base32 round-trips every byte string", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
      expect([...base32Decode(base32Encode(Buffer.from(bytes)))]).toEqual([...bytes]);
    }), runs);
  });
  it("verification rejects any code that is not exactly six digits and never throws", () => {
    const secret = base32Encode(Buffer.from("0123456789abcdef0123"));
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (code) => {
        if (!/^\d{6}$/.test(code)) expect(verifyTotp(secret, code, 1_700_000_000_000)).toBeNull();
        else expect(() => verifyTotp(secret, code, 1_700_000_000_000)).not.toThrow();
      }),
      runs
    );
  });
});

describe("mail rendering", () => {
  it("escapes every HTML metacharacter", () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (text) => { expect(escapeHtml(text)).not.toMatch(/[<>"']|&(?!(amp|lt|gt|quot|#39);)/); }), runs);
  });
  it("renders any link and locale without throwing or leaking a raw tag into the HTML part", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), fc.option(fc.string({ maxLength: 20 }), { nil: undefined }), (link, locale) => {
        const mail = renderMail(mailLocale(locale), { kind: "password-reset", link, validForMinutes: 60 }, "user@example.test");
        expect(mail.html).not.toContain("<script");
        expect(mail.to).toBe("user@example.test");
      }),
      runs
    );
  });
});

describe("environment validation", () => {
  const base = { DATABASE_URL: "postgresql://safry:password@localhost:5432/safry", JWT_ACCESS_SECRET: "a-secure-test-secret-with-32-characters" };
  it("answers any numeric tunable with a value or an Error, never another throwable", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 12 }), fc.integer(), fc.double()), (value) => {
        try {
          validateEnvironment({ ...base, MAIL_RETRY_ATTEMPTS: String(value), MAIL_RETRY_BASE_MS: String(value), AUTH_CACHE_TTL_MS: String(value) });
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }),
      runs
    );
  });
});
