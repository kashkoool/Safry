import { useMemo } from "react";
import { useLanguage } from "../i18n/useLanguage";
import { currencyNames } from "../lib/api";
import { englishCurrencyNames } from "../i18n/labels";
import { sameOriginLogo, supportedTimeZones, tenantCurrencies, tenantLocales, type SettingsForm } from "../lib/tenant-settings";
import { TenantMark } from "./TenantMark";

/** Locale, time zone, currency and branding inputs shared by the workspace settings page and the new-workspace dialog. */
export function TenantSettingsFields({ value, onChange, disabled = false, name, idPrefix }: {
  value: SettingsForm;
  onChange: (next: SettingsForm) => void;
  disabled?: boolean;
  name: string;
  idPrefix: string;
}) {
  const { pick } = useLanguage();
  const zones = useMemo(() => supportedTimeZones(), []);
  const set = (patch: Partial<SettingsForm>) => onChange({ ...value, ...patch });
  const logo = sameOriginLogo(value.logoUrl.trim());
  const zoneOptions = value.timezone && !zones.includes(value.timezone) ? [value.timezone, ...zones] : zones;
  return (
    <>
      <div className="ta-row">
        <label>{pick("اللغة الافتراضية", "Default language")}
          <select disabled={disabled} value={value.locale} onChange={(e) => set({ locale: e.target.value })}>
            {!value.locale && <option value="">{pick("غير محددة", "Not set")}</option>}
            {tenantLocales.map((l) => <option key={l} value={l}>{l === "ar-SA" ? pick("العربية", "Arabic") : pick("الإنجليزية", "English")}</option>)}
          </select>
        </label>
        <label>{pick("العملة الافتراضية", "Default currency")}
          <select disabled={disabled} value={value.currency} onChange={(e) => set({ currency: e.target.value })}>
            {!value.currency && <option value="">{pick("غير محددة", "Not set")}</option>}
            {tenantCurrencies.map((c) => <option key={c} value={c}>{c} · {pick(currencyNames[c], englishCurrencyNames[c])}</option>)}
          </select>
        </label>
      </div>
      <label>{pick("المنطقة الزمنية", "Time zone")}
        <select disabled={disabled} value={value.timezone} onChange={(e) => set({ timezone: e.target.value })} dir="ltr">
          {!value.timezone && <option value="">{pick("غير محددة (توقيت المتصفح)", "Not set (browser time)")}</option>}
          {zoneOptions.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </label>
      <div className="ta-row">
        <div>
          <label className="ta-inline">
            <input type="checkbox" disabled={disabled} checked={value.useColor} onChange={(e) => set({ useColor: e.target.checked })} />
            {pick("استخدام لون العلامة", "Use a brand colour")}
          </label>
          <label>{pick("لون العلامة", "Brand colour")}
            <input id={`${idPrefix}-color`} type="color" disabled={disabled || !value.useColor} value={value.primaryColor} onChange={(e) => set({ primaryColor: e.target.value })} />
          </label>
        </div>
        <label>{pick("رابط الشعار (https)", "Logo URL (https)")}
          <input id={`${idPrefix}-logo`} type="url" dir="ltr" disabled={disabled} maxLength={500} pattern="https://.*" autoComplete="off" value={value.logoUrl}
            onChange={(e) => set({ logoUrl: e.target.value })} aria-describedby={`${idPrefix}-logo-hint`} />
          <span id={`${idPrefix}-logo-hint`} className="ta-field-hint">
            {pick("يظهر الشعار فقط إذا كان مستضافاً على عنوان هذا التطبيق نفسه؛ المتصفح يحجب صور المواقع الأخرى. وإلا تظهر الأحرف الأولى من الاسم.", "The logo appears only when it is hosted on this app's own address; the browser blocks images from other sites. Otherwise the initials of the name are shown.")}
          </span>
        </label>
      </div>
      <div className="ta-logo-preview" aria-label={pick("معاينة العلامة", "Brand preview")}>
        <TenantMark name={name || "?"} settings={{ branding: { ...(value.useColor ? { primaryColor: value.primaryColor } : {}), ...(logo ? { logoUrl: logo } : {}) } }} />
        <span className="ta-field-hint">{logo ? pick("الشعار سيظهر.", "The logo will be shown.") : value.logoUrl.trim() ? pick("هذا الرابط لن يظهر؛ سيُستخدم الاسم المختصر.", "This URL will not be displayed; the initials are used instead.") : pick("تُستخدم الأحرف الأولى من الاسم.", "The initials of the name are used.")}</span>
      </div>
    </>
  );
}
