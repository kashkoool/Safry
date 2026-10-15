import { describe, expect, it } from "vitest";
import { translateText } from "./translate";

describe("translateText", () => {
  it("returns system messages in the requested language", () => {
    expect(translateText("Unauthorized", "en")).toBe("Please sign in again");
    expect(translateText("Unauthorized", "ar")).toBe("انتهت الجلسة أو يلزم تسجيل الدخول");
    expect(translateText("  Forbidden   resource ", "en")).toBe("You do not have permission for this action");
  });

  it("translates status and category enums", () => {
    expect(translateText("PENDING", "en")).toBe("Pending");
    expect(translateText("CANCELLED", "ar")).toBe("ملغي");
    expect(translateText("UMRAH", "en")).toBe("Umrah package");
  });

  it("translates field validation messages with their limits", () => {
    expect(translateText("password must be longer than or equal to 12 characters", "en"))
      .toBe("password must be longer than or equal to 12 characters");
    expect(translateText("password must be longer than or equal to 12 characters", "ar")).toBe("كلمة المرور: الحد الأدنى 12 أحرف");
    expect(translateText("email must be shorter than or equal to 254 characters", "ar")).toBe("البريد الإلكتروني: الحد الأقصى 254 أحرف");
  });

  it("translates each part of a joined label", () => {
    expect(translateText("ACTIVE، SUSPENDED", "en")).toBe("Active, Suspended");
    expect(translateText("ACTIVE، SUSPENDED", "ar")).toBe("نشط، موقوف");
  });

  it("returns unknown English text unchanged", () => {
    expect(translateText("Some text nobody registered", "en")).toBe("Some text nobody registered");
    expect(translateText("Some text nobody registered", "ar")).toBe("Some text nobody registered");
  });

  // KNOWN BUG (report only, not fixed): systemText is a plain object literal, so inherited keys such as "constructor"
  // resolve to Object.prototype members and translateText returns undefined. it.fails keeps the suite green until fixed;
  // when the bug is fixed this test starts passing and it.fails must be changed to it.
  it.fails("does not return inherited Object.prototype members as translations", () => {
    expect(translateText("constructor", "en")).toBe("constructor");
  });
});
