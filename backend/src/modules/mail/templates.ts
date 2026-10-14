import type { MailMessage } from "./mail.types.js";

export type MailLocale = "ar" | "en";
export type MailTemplate =
  | { kind: "password-reset"; link: string; validForMinutes: number }
  | { kind: "email-verification"; link: string; validForHours: number }
  | { kind: "password-changed" };

/** `ar`, `ar-SA` ... select Arabic; anything else (or nothing) selects English. */
export function mailLocale(locale: string | null | undefined): MailLocale {
  return /^ar(\b|[-_])/i.test((locale ?? "").trim()) ? "ar" : "en";
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

interface Copy {
  subject: string;
  heading: string;
  lines: string[];
  action?: { label: string; link: string };
  footer: string;
}

function copy(locale: MailLocale, template: MailTemplate): Copy {
  const ar = locale === "ar";
  switch (template.kind) {
    case "password-reset":
      return ar
        ? {
            subject: "إعادة تعيين كلمة المرور - سفري",
            heading: "إعادة تعيين كلمة المرور",
            lines: [`وصلنا طلب لإعادة تعيين كلمة مرور حسابك. الرابط صالح لمدة ${template.validForMinutes} دقيقة ويُستخدم مرة واحدة.`],
            action: { label: "تعيين كلمة مرور جديدة", link: template.link },
            footer: "إذا لم تطلب ذلك فتجاهل هذه الرسالة؛ لن يتغير شيء في حسابك."
          }
        : {
            subject: "Reset your Safry password",
            heading: "Reset your password",
            lines: [`We received a request to reset the password of your account. The link works once and expires in ${template.validForMinutes} minutes.`],
            action: { label: "Choose a new password", link: template.link },
            footer: "If you did not ask for this, ignore this message; nothing changes on your account."
          };
    case "email-verification":
      return ar
        ? {
            subject: "تأكيد بريدك الإلكتروني - سفري",
            heading: "تأكيد البريد الإلكتروني",
            lines: [`أكّد بريدك الإلكتروني لتفعيل تسجيل الدخول. الرابط صالح لمدة ${template.validForHours} ساعة ويُستخدم مرة واحدة.`],
            action: { label: "تأكيد البريد الإلكتروني", link: template.link },
            footer: "إذا لم تنشئ حساباً في سفري فتجاهل هذه الرسالة."
          }
        : {
            subject: "Confirm your Safry e-mail address",
            heading: "Confirm your e-mail address",
            lines: [`Confirm your e-mail address to enable sign-in. The link works once and expires in ${template.validForHours} hours.`],
            action: { label: "Confirm e-mail address", link: template.link },
            footer: "If you did not create a Safry account, ignore this message."
          };
    case "password-changed":
      return ar
        ? {
            subject: "تم تغيير كلمة مرور حسابك - سفري",
            heading: "تم تغيير كلمة المرور",
            lines: ["تم تغيير كلمة مرور حسابك وإنهاء جميع الجلسات المفتوحة."],
            footer: "إذا لم تكن أنت من فعل ذلك، فاطلب إعادة تعيين كلمة المرور فوراً وتواصل مع الدعم."
          }
        : {
            subject: "Your Safry password was changed",
            heading: "Your password was changed",
            lines: ["The password of your account was changed and every open session was signed out."],
            footer: "If this was not you, reset your password immediately and contact support."
          };
  }
}

/**
 * Plain text plus simple HTML, no remote images and no tracking pixels or rewritten links. The link is shown in full in both
 * parts. Arabic is right-to-left (`dir="rtl"` on the document and the container). Every interpolated value is HTML-escaped.
 */
export function renderMail(locale: MailLocale, template: MailTemplate, to: string): MailMessage {
  const c = copy(locale, template);
  const rtl = locale === "ar";
  const text = [c.heading, "", ...c.lines, ...(c.action ? ["", `${c.action.label}:`, c.action.link] : []), "", c.footer, ""].join("\n");
  const paragraphs = c.lines.map((line) => `<p style="margin:0 0 16px">${escapeHtml(line)}</p>`).join("");
  const button = c.action
    ? `<p style="margin:0 0 16px"><a href="${escapeHtml(c.action.link)}" style="display:inline-block;padding:10px 18px;background:#0f5132;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(c.action.label)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:13px;word-break:break-all;direction:ltr;text-align:${rtl ? "right" : "left"}">${escapeHtml(c.action.link)}</p>`
    : "";
  const html =
    `<!doctype html><html lang="${locale}" dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><title>${escapeHtml(c.subject)}</title></head>` +
    `<body dir="${rtl ? "rtl" : "ltr"}" style="margin:0;padding:24px;font-family:Tahoma,Arial,sans-serif;color:#1a1a1a;text-align:${rtl ? "right" : "left"}">` +
    `<div dir="${rtl ? "rtl" : "ltr"}" style="max-width:520px;margin:0 auto"><h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(c.heading)}</h1>${paragraphs}${button}` +
    `<p style="margin:24px 0 0;font-size:13px;color:#555555">${escapeHtml(c.footer)}</p></div></body></html>`;
  return { to, subject: c.subject, text, html };
}
