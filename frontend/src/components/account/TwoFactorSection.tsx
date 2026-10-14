import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { api, type MfaStatus } from "../../lib/api";
import { account, type MfaSetup } from "../../lib/account";
import { errorText } from "../../lib/errors";
import { useRetryCountdown } from "../../lib/useRetryCountdown";
import { Skeleton } from "../LoadingScreen";
import { RecoveryCodes } from "./RecoveryCodes";
import { useLanguage } from "../../i18n/useLanguage";
import { useText } from "../../i18n/useText";

// The QR generator is only needed on the scan step: it is fetched then, not with the page.
const QrCode = lazy(() => import("./QrCode"));

type Step = "overview" | "password" | "scan" | "codes" | "regenerate" | "disable";

const groupKey = (secret: string): string => secret.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

/**
 * Two-factor sign-in: turn on (password -> QR + manual key -> 6-digit code -> recovery codes shown once), turn off
 * (password + code), and create a new set of recovery codes on demand. Secrets (password, code, TOTP key, recovery
 * codes) live in component state only and are dropped as soon as the step that needed them ends.
 */
export function TwoFactorSection() {
  const { pick } = useLanguage();
  const tr = useText();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ reason: unknown } | null>(null);
  const [step, setStep] = useState<Step>("overview");
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  const refresh = useCallback(() => {
    api.mfaStatus().then(
      (next) => { setStatus(next); setLoadFailure(null); },
      (reason: unknown) => setLoadFailure({ reason })
    );
  }, []);
  useEffect(() => {
    let live = true;
    api.mfaStatus().then(
      (next) => { if (live) { setStatus(next); setLoadFailure(null); } },
      (reason: unknown) => { if (live) setLoadFailure({ reason }); }
    );
    return () => { live = false; };
  }, []);
  // Moving between steps moves focus to the step heading, so keyboard and screen reader users land on the new content.
  useEffect(() => { if (step !== "overview") heading.current?.focus(); }, [step]);

  function backToOverview(message = "") {
    setSetup(null);
    setCodes(null);
    setNotice(message);
    setStep("overview");
    refresh();
  }

  if (loadFailure) {
    return (
      <div>
        <p role="alert" className="form-error">{errorText(loadFailure.reason, pick, tr, { fallback: pick("تعذر تحميل حالة المصادقة الثنائية.", "Could not load your two-factor status.") })}</p>
        <button type="button" className="secondary-button" onClick={() => { setLoadFailure(null); refresh(); }}>{pick("إعادة المحاولة", "Try again")}</button>
      </div>
    );
  }
  if (!status) return <div role="status" aria-label={pick("جاري التحميل", "Loading")}><Skeleton rows={2} /></div>;

  const title = (text: string): ReactNode => <h3 ref={heading} tabIndex={-1}>{text}</h3>;

  if (step === "password") {
    return (
      <div className="account-step" key={step}>
        {title(pick("الخطوة 1 من 3: أكّد كلمة المرور", "Step 1 of 3: confirm your password"))}
        <SecretForm
          fields={["password"]}
          submitLabel={pick("متابعة", "Continue")}
          onCancel={() => backToOverview()}
          onSubmit={async ({ password }) => { setSetup(await account.mfaSetup(password)); setStep("scan"); }}
        >
          <p className="form-hint">{pick("نطلب كلمة مرورك قبل إنشاء مفتاح جديد.", "We ask for your password before creating a new key.")}</p>
        </SecretForm>
      </div>
    );
  }
  if (step === "scan" && setup) {
    return (
      <div className="account-step" key={step}>
        {title(pick("الخطوة 2 من 3: اربط تطبيق المصادقة", "Step 2 of 3: link your authenticator app"))}
        <p>{pick("امسح الرمز بتطبيق المصادقة، أو أدخل المفتاح يدوياً. ثم اكتب الرمز المكوّن من 6 أرقام الذي يعرضه التطبيق.", "Scan the code with your authenticator app, or type the key in by hand. Then enter the 6-digit code the app shows.")}</p>
        <div className="account-scan">
          <Suspense fallback={<div className="account-qr account-qr--loading" role="status" aria-label={pick("جاري تحميل الرمز", "Loading the code")} />}>
            <QrCode value={setup.otpauthUri} label={pick("رمز QR لربط تطبيق المصادقة", "QR code for linking your authenticator app")} />
          </Suspense>
          <div>
            <p className="form-hint" id="mfa-key-label">{pick("المفتاح اليدوي", "Manual key")}</p>
            <code className="account-key" dir="ltr" aria-labelledby="mfa-key-label">{groupKey(setup.secret)}</code>
          </div>
        </div>
        <SecretForm
          fields={["code"]}
          submitLabel={pick("تفعيل", "Turn on")}
          onCancel={() => backToOverview()}
          onSubmit={async ({ code }) => {
            const result = await account.mfaEnable(code);
            setSetup(null); // the key is no longer needed once the server has it enabled
            setCodes(result.recoveryCodes);
            setStep("codes");
          }}
        />
      </div>
    );
  }
  if (step === "codes" && codes) {
    return (
      <div className="account-step" key={step}>
        {title(pick("الخطوة 3 من 3: رموز الاسترداد", "Step 3 of 3: recovery codes"))}
        <RecoveryCodes codes={codes} onDone={() => backToOverview(pick("المصادقة الثنائية جاهزة.", "Two-factor sign-in is on."))} />
      </div>
    );
  }
  if (step === "regenerate") {
    return (
      <div className="account-step" key={step}>
        {title(pick("إنشاء رموز استرداد جديدة", "Create new recovery codes"))}
        <SecretForm
          fields={["password", "code"]}
          submitLabel={pick("إنشاء الرموز", "Create codes")}
          onCancel={() => backToOverview()}
          onSubmit={async ({ password, code }) => {
            const result = await api.regenerateRecoveryCodes(password, code);
            setCodes(result.recoveryCodes);
            setStep("codes");
          }}
        >
          <p className="form-hint">{pick("الرموز القديمة تتوقف عن العمل فور إنشاء الجديدة.", "Your old codes stop working as soon as the new ones exist.")}</p>
        </SecretForm>
      </div>
    );
  }
  if (step === "disable") {
    return (
      <div className="account-step" key={step}>
        {title(pick("إيقاف المصادقة الثنائية", "Turn off two-factor sign-in"))}
        <SecretForm
          fields={["password", "code"]}
          codeAnyLength
          submitLabel={pick("إيقاف", "Turn off")}
          danger
          onCancel={() => backToOverview()}
          onSubmit={async ({ password, code }) => {
            await account.mfaDisable(password, code);
            backToOverview(pick("أُوقفت المصادقة الثنائية، وأُنهيت جلساتك على الأجهزة الأخرى.", "Two-factor sign-in is off. Your other devices were signed out."));
          }}
        >
          <p className="form-hint">{pick("يمكنك استخدام رمز التطبيق أو أحد رموز الاسترداد. ستقل حماية حسابك.", "You can use an app code or one of your recovery codes. Your account will be less protected.")}</p>
        </SecretForm>
      </div>
    );
  }

  return (
    <div className="account-step" key={step}>
      {notice && <p role="status" className="workspace-alert">{notice}</p>}
      <p className="account-status">
        {status.enabled
          ? <><ShieldCheck size={18} aria-hidden="true" /> {pick("المصادقة الثنائية: مفعّلة", "Two-factor sign-in: on")}</>
          : <><ShieldOff size={18} aria-hidden="true" /> {pick("المصادقة الثنائية: غير مفعّلة", "Two-factor sign-in: off")}</>}
      </p>
      {status.enabled ? (
        <>
          <p className="form-hint">
            {pick("رموز الاسترداد المتبقية: ", "Recovery codes left: ")}<bdi>{status.recoveryCodesRemaining.toLocaleString()}</bdi>
          </p>
          {status.recoveryCodesRegenerationRequired && (
            <p role="alert" className="form-error">{pick("رموز الاسترداد القديمة لم تعد تعمل. أنشئ رموزاً جديدة.", "Your old recovery codes no longer work. Create new ones.")}</p>
          )}
          <div className="account-actions">
            <button type="button" className="secondary-button" onClick={() => { setNotice(""); setStep("regenerate"); }}>{pick("إنشاء رموز استرداد جديدة", "Create new recovery codes")}</button>
            <button type="button" className="ghost-button" onClick={() => { setNotice(""); setStep("disable"); }}>{pick("إيقاف المصادقة الثنائية", "Turn off two-factor sign-in")}</button>
          </div>
        </>
      ) : (
        <>
          <p className="form-hint">
            {status.pendingSetup
              ? pick("بدأت الإعداد ولم تكمله. ابدأ من جديد للحصول على مفتاح جديد.", "You started setting this up but did not finish. Start again to get a new key.")
              : pick("أضف خطوة ثانية عند تسجيل الدخول باستخدام تطبيق مصادقة على هاتفك.", "Add a second step to sign-in with an authenticator app on your phone.")}
          </p>
          <div className="account-actions">
            <button type="button" className="primary-button" onClick={() => { setNotice(""); setStep("password"); }}>
              {status.pendingSetup ? pick("ابدأ الإعداد من جديد", "Start setup again") : pick("تفعيل المصادقة الثنائية", "Turn on two-factor sign-in")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

type Field = "password" | "code";
interface SecretFormProps {
  fields: Field[];
  submitLabel: string;
  onSubmit: (values: { password: string; code: string }) => Promise<void>;
  onCancel: () => void;
  /** Accept an app code OR a recovery code (6-24 characters) instead of exactly six digits. */
  codeAnyLength?: boolean;
  danger?: boolean;
  children?: ReactNode;
}

/** A small password/code form. Both values are cleared after EVERY attempt; a 401 means "wrong secret" here. */
function SecretForm({ fields, submitLabel, onSubmit, onCancel, codeAnyLength = false, danger = false, children }: SecretFormProps) {
  const { pick } = useLanguage();
  const tr = useText();
  const id = useId();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const throttle = useRetryCountdown();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit({ password, code });
    } catch (reason) {
      throttle.note(reason);
      setError(errorText(reason, pick, tr, {
        wrongSecret: fields.includes("password")
          ? pick("كلمة المرور أو رمز التحقق غير صحيح.", "The password or verification code is incorrect.")
          : pick("رمز التحقق غير صحيح.", "The verification code is incorrect.")
      }));
    } finally {
      setPassword("");
      setCode("");
      setBusy(false);
    }
  }

  return (
    <form className="account-form" onSubmit={(event) => void submit(event)}>
      {children}
      {fields.includes("password") && (
        <label>
          {pick("كلمة المرور الحالية", "Current password")}
          <input dir="ltr" type="password" required minLength={8} maxLength={128} autoComplete="current-password" value={password}
            onChange={(event) => setPassword(event.target.value)} />
        </label>
      )}
      {fields.includes("code") && (
        <label>
          {codeAnyLength ? pick("رمز التطبيق أو رمز استرداد", "App code or recovery code") : pick("رمز التحقق من التطبيق (6 أرقام)", "Authenticator app code (6 digits)")}
          {codeAnyLength
            ? <input dir="ltr" required minLength={6} maxLength={24} autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.trim())} />
            : <input dir="ltr" required inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" value={code}
                aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />}
        </label>
      )}
      {error && <p id={`${id}-error`} role="alert" className="form-error">{error}</p>}
      <div className="account-actions">
        <button className={danger ? "secondary-button account-danger" : "primary-button"} type="submit" disabled={busy || throttle.remaining > 0}>
          {throttle.remaining > 0 ? pick(`أعد المحاولة بعد ${throttle.remaining} ث`, `Try again in ${throttle.remaining} s`) : submitLabel}
        </button>
        <button className="ghost-button" type="button" disabled={busy} onClick={onCancel}>{pick("إلغاء", "Cancel")}</button>
      </div>
    </form>
  );
}
