import { useLanguage } from "../i18n/useLanguage";

export function Brand({ compact = false }: { compact?: boolean }) {
  const { pick } = useLanguage();
  return (
    <div className={`brand ${compact ? "brand--compact" : ""}`}>
      <span className="brand__mark" aria-hidden="true">
        <svg width={compact ? 25 : 29} height={compact ? 25 : 29} viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path d="M7 25 13 7l12 18-9-4-9 4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="m13 7 3 14 9 4M7 25l9-4" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <circle cx="25" cy="7" r="2" fill="currentColor" />
        </svg>
      </span>
      <span>
        <strong>{pick("سفري", "Safry")}</strong>
        {!compact && <small>{pick("منصة إدارة السفر", "Travel Management Platform")}</small>}
      </span>
    </div>
  );
}
