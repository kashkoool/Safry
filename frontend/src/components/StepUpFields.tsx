import { useLanguage } from "../i18n/useLanguage";

import type { Creds } from "./step-up";

/** Current password + optional MFA code of the acting user; the parent clears both after every attempt. */
export function StepUpFields({ value, onChange }: { value: Creds; onChange: (next: Creds) => void }) {
  const { pick } = useLanguage();
  return (
    <>
      <label>{pick("كلمة مرورك الحالية", "Your current password")}<input
          type="password"
          required
          maxLength={128}
          autoComplete="current-password"
          value={value.currentPassword}
          onChange={(e) => onChange({ ...value, currentPassword: e.target.value })}
        />
      </label>
      <label>{pick("رمز التحقق (إن كانت المصادقة الثنائية مفعّلة)", "Verification code (if you use two-factor sign-in)")}<input
          dir="ltr"
          maxLength={64}
          minLength={6}
          autoComplete="one-time-code"
          value={value.mfaCode}
          onChange={(e) => onChange({ ...value, mfaCode: e.target.value })}
        />
      </label>
    </>
  );
}
