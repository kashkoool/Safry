import { useEffect, useId, useState, type FormEvent } from "react";
import { BadgeCheck, CircleAlert } from "lucide-react";
import { account, type ProfileLocale, type UserProfile } from "../../lib/account";
import { errorText } from "../../lib/errors";
import { useRetryCountdown } from "../../lib/useRetryCountdown";
import { Skeleton } from "../LoadingScreen";
import { useLanguage } from "../../i18n/useLanguage";
import { useText } from "../../i18n/useText";

const PHONE_PATTERN = "\\+?[0-9 ()\\-]{6,32}";
const toForm = (profile: UserProfile) => ({
  displayName: profile.displayName,
  phone: profile.phone ?? "",
  locale: (profile.locale === "en-US" ? "en-US" : "ar-SA") as ProfileLocale
});

/** GET/PATCH /users/me: name, phone and language. The e-mail address is the sign-in identity and is shown, not edited. */
export function ProfileSection() {
  const { pick, setLanguage } = useLanguage();
  const tr = useText();
  const id = useId();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [form, setForm] = useState({ displayName: "", phone: "", locale: "ar-SA" as ProfileLocale });
  const [loadFailure, setLoadFailure] = useState<{ reason: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const throttle = useRetryCountdown();

  useEffect(() => {
    let live = true;
    account.profile().then(
      (next) => { if (live) { setProfile(next); setForm(toForm(next)); setLoadFailure(null); } },
      (reason: unknown) => { if (live) setLoadFailure({ reason }); }
    );
    return () => { live = false; };
  }, [attempt]);

  if (loadFailure) {
    return (
      <div>
        <p role="alert" className="form-error">{errorText(loadFailure.reason, pick, tr, { fallback: pick("تعذر تحميل ملفك الشخصي.", "Could not load your profile.") })}</p>
        <button type="button" className="secondary-button" onClick={() => { setLoadFailure(null); setAttempt((n) => n + 1); }}>{pick("إعادة المحاولة", "Try again")}</button>
      </div>
    );
  }
  if (!profile) return <div role="status" aria-label={pick("جاري التحميل", "Loading")}><Skeleton rows={3} /></div>;

  const current = toForm(profile);
  const changes = {
    ...(form.displayName.trim() !== current.displayName ? { displayName: form.displayName.trim() } : {}),
    ...(form.phone.trim() !== current.phone ? { phone: form.phone.trim() || null } : {}),
    ...(form.locale !== current.locale ? { locale: form.locale } : {})
  };
  const dirty = Object.keys(changes).length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = await account.updateProfile(changes);
      setProfile(next);
      setForm(toForm(next));
      setSaved(true);
      if (changes.locale) setLanguage(changes.locale === "en-US" ? "en" : "ar"); // keep the saved language and the UI language in step
    } catch (reason) {
      throttle.note(reason);
      setError(errorText(reason, pick, tr));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="account-form" onSubmit={(event) => void submit(event)}>
      <p className="account-status">
        {profile.emailVerifiedAt
          ? <><BadgeCheck size={18} aria-hidden="true" /> {pick("بريدك الإلكتروني موثّق", "Your e-mail address is verified")}</>
          : <><CircleAlert size={18} aria-hidden="true" /> {pick("بريدك الإلكتروني غير موثّق بعد", "Your e-mail address is not verified yet")}</>}
      </p>
      <label>
        {pick("البريد الإلكتروني", "E-mail address")}
        <input dir="ltr" type="email" readOnly value={profile.email} aria-describedby={`${id}-email`} />
        <small id={`${id}-email`} className="form-hint">{pick("هذا بريد تسجيل الدخول ولا يمكن تغييره من هنا.", "This is your sign-in address and cannot be changed here.")}</small>
      </label>
      <label>
        {pick("الاسم الظاهر", "Display name")}
        <input required minLength={2} maxLength={200} autoComplete="name" value={form.displayName}
          onChange={(event) => { setSaved(false); setForm({ ...form, displayName: event.target.value }); }} />
      </label>
      <label>
        {pick("رقم الهاتف (اختياري)", "Phone number (optional)")}
        <input dir="ltr" type="tel" inputMode="tel" autoComplete="tel" maxLength={32} pattern={PHONE_PATTERN} value={form.phone}
          title={pick("أرقام ومسافات وأقواس وشرطات، من 6 إلى 32 خانة", "Digits, spaces, brackets and dashes, 6 to 32 characters")}
          onChange={(event) => { setSaved(false); setForm({ ...form, phone: event.target.value }); }} />
      </label>
      <label>
        {pick("لغة الواجهة", "Interface language")}
        <select value={form.locale} onChange={(event) => { setSaved(false); setForm({ ...form, locale: event.target.value as ProfileLocale }); }}>
          <option value="ar-SA">{pick("العربية", "Arabic")}</option>
          <option value="en-US">{pick("الإنجليزية", "English")}</option>
        </select>
      </label>
      {error && <p role="alert" className="form-error">{error}</p>}
      {saved && <p role="status" className="workspace-alert">{pick("تم حفظ ملفك الشخصي.", "Your profile was saved.")}</p>}
      <div className="account-actions">
        <button className="primary-button" type="submit" disabled={busy || !dirty || throttle.remaining > 0}>
          {throttle.remaining > 0 ? pick(`أعد المحاولة بعد ${throttle.remaining} ث`, `Try again in ${throttle.remaining} s`) : pick("حفظ التغييرات", "Save changes")}
        </button>
        {dirty && <button className="ghost-button" type="button" disabled={busy} onClick={() => { setForm(current); setError(""); }}>{pick("تراجع", "Discard changes")}</button>}
      </div>
    </form>
  );
}
