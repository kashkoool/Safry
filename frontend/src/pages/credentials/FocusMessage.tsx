import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

/** Result message that takes keyboard focus when it appears, so screen readers and keyboard users land on the outcome. */
export function FocusMessage({ kind, title, children }: { kind: "success" | "error" | "info"; title?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const Icon = kind === "success" ? CheckCircle2 : kind === "error" ? AlertTriangle : Info;
  return <div ref={ref} tabIndex={-1} role={kind === "error" ? "alert" : "status"} className={`credential-message credential-message--${kind}`}>
    <Icon size={22} aria-hidden="true" />
    <div>{title && <strong>{title}</strong>}<p>{children}</p></div>
  </div>;
}
