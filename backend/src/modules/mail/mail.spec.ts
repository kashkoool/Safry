import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { ConsoleTransport } from "./console.transport.js";
import { createMailTransport, mailTransportName, appBaseUrl } from "./mail.config.js";
import { MailService } from "./mail.service.js";
import { MailDeliveryError } from "./mail.types.js";
import { ResendTransport } from "./resend.transport.js";
import { escapeHtml, mailLocale, renderMail } from "./templates.js";

const message = { to: "a@b.test", subject: "S", text: "link https://x.test/p#token=SECRET", html: "<p>h</p>" };
const key = "re_test_key_not_real_0123456789";

describe("transport selection", () => {
  const cfg = (values: Record<string, string>): ConfigService => new ConfigService(values);
  it("console by default outside production, resend in production, explicit setting wins", () => {
    expect(mailTransportName(cfg({}))).toBe("console");
    expect(mailTransportName(cfg({ NODE_ENV: "production" }))).toBe("resend");
    expect(mailTransportName(cfg({ NODE_ENV: "production", MAIL_TRANSPORT: "console" }))).toBe("console");
    expect(mailTransportName(cfg({ MAIL_TRANSPORT: "resend" }))).toBe("resend");
  });
  it("builds the transport the settings ask for", () => {
    expect(createMailTransport(cfg({ NODE_ENV: "test" })).name).toBe("console");
    expect(createMailTransport(cfg({ MAIL_TRANSPORT: "resend", RESEND_API_KEY: key, MAIL_FROM: "Safry <no-reply@mail.safry.test>" })).name).toBe("resend");
  });
  it("normalises the frontend origin", () => {
    expect(appBaseUrl(cfg({ APP_BASE_URL: "https://app.safry.test/" }))).toBe("https://app.safry.test");
    expect(appBaseUrl(cfg({}))).toBe("http://localhost:3001");
  });
});

describe("Resend transport", () => {
  const okFetch = (): typeof fetch => vi.fn(() => Promise.resolve(new Response('{"id":"1"}', { status: 200 }))) as unknown as typeof fetch;
  it("posts to the Resend API with a bearer key, an idempotency key and a timeout signal", async () => {
    const fetchImpl = okFetch();
    await new ResendTransport(key, "Safry <no-reply@mail.safry.test>", 5000, "https://api.resend.test/emails", fetchImpl).send(message, "idem-1");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.test/emails");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({ authorization: `Bearer ${key}`, "idempotency-key": "idem-1" });
    expect(JSON.parse(init.body as string)).toEqual({ from: "Safry <no-reply@mail.safry.test>", to: ["a@b.test"], subject: "S", text: message.text, html: message.html });
  });
  it("errors name only the status or failure kind: never the key, recipient or body", async () => {
    const failing = (response: Response | Error): typeof fetch =>
      vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response))) as unknown as typeof fetch;
    const send = (f: typeof fetch): Promise<void> => new ResendTransport(key, "no-reply@mail.safry.test", 50, "https://api.resend.test/emails", f).send(message, "i");
    const refused = await send(failing(new Response('{"message":"to a@b.test invalid"}', { status: 422 }))).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(MailDeliveryError);
    expect((refused as MailDeliveryError).status).toBe(422);
    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const slow = await send(failing(timeout)).catch((e: unknown) => e);
    expect((slow as Error).message).toBe("mail provider timed out");
    const down = await send(failing(new TypeError("fetch failed: token re_secret"))).catch((e: unknown) => e);
    for (const error of [refused, slow, down]) {
      const text = (error as Error).message;
      expect(text).not.toContain(key);
      expect(text).not.toContain("a@b.test");
      expect(text).not.toContain("secret");
    }
  });
  it("really aborts a request that hangs", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const started = Date.now();
    await expect(new ResendTransport(key, "no-reply@mail.safry.test", 40, "https://api.resend.test/emails", hang).send(message, "i")).rejects.toThrow("mail provider timed out");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("console transport and the mail service", () => {
  it("keeps a bounded outbox", async () => {
    const transport = new ConsoleTransport(2, false);
    for (const n of [1, 2, 3]) await transport.send({ ...message, subject: `s${n}` }, `k${n}`);
    expect(transport.outbox.map((m) => m.subject)).toEqual(["s2", "s3"]);
  });
  it("detached delivery swallows a provider failure and logs neither recipient nor body", async () => {
    const failing = { name: "console" as const, send: () => Promise.reject(new MailDeliveryError("mail provider answered HTTP 500", 500)) };
    const service = new MailService(failing);
    const errors: string[] = [];
    (service as unknown as { logger: { error: (m: string) => void } }).logger = { error: (m) => errors.push(m) };
    service.sendDetached("victim@example.test", "en", { kind: "password-changed" });
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual(['mail "password-changed" not delivered: mail provider answered HTTP 500']);
  });
});

describe("templates", () => {
  const reset = { kind: "password-reset" as const, link: "https://app.safry.test/reset-password#token=abc", validForMinutes: 60 };
  it("chooses the locale: Arabic variants map to ar, everything else to en", () => {
    for (const l of ["ar", "ar-SA", "AR", "ar_EG"]) expect(mailLocale(l)).toBe("ar");
    for (const l of ["en", "en-GB", "fr", "", null, undefined, "arabic-ish-xx"]) expect(mailLocale(l)).toBe("en");
  });
  it("renders plain text and simple HTML in both languages, rtl for Arabic, with the full link in both parts", () => {
    for (const locale of ["ar", "en"] as const) {
      const mail = renderMail(locale, reset, "u@x.test");
      expect(mail.text).toContain(reset.link);
      expect(mail.html).toContain(reset.link);
      expect(mail.html).toContain(locale === "ar" ? 'dir="rtl"' : 'dir="ltr"');
      expect(mail.html).not.toMatch(/<img|<script|<link|url\(|src=/i);
    }
  });
  it("escapes everything it interpolates", () => {
    const evil = renderMail("en", { ...reset, link: 'https://x.test/"><script>alert(1)</script>' }, "u@x.test");
    expect(evil.html).not.toContain("<script>");
    expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  });
  it("covers every template kind with a distinct subject per language", () => {
    const kinds = [reset, { kind: "email-verification" as const, link: "https://a.test/v#token=x", validForHours: 24 }, { kind: "password-changed" as const }];
    for (const locale of ["ar", "en"] as const) expect(new Set(kinds.map((k) => renderMail(locale, k, "u@x.test").subject)).size).toBe(3);
  });
});
