import { useText } from "../i18n/useText";
import { Brand } from "./Brand";

/** Placeholder blocks reserve the layout of the loaded page so nothing jumps when data arrives. */
export function Skeleton({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`skeleton-list ${className}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => <span className="skeleton-block" key={index} />)}
    </div>
  );
}

export function LoadingScreen() {
  const tr = useText();
  return (
    <main className="loading-screen" role="status" aria-label={tr("جاري التحميل")} aria-busy="true">
      <Brand />
      <Skeleton rows={3} className="skeleton-list--screen" />
    </main>
  );
}
