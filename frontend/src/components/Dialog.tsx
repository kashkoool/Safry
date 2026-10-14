import { useEffect, useRef, type ReactNode } from "react";
import { Modal } from "./BusinessForms";

/** Modal that hands focus back to the control that opened it once it closes (Esc, close button or unmount). */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useEffect(() => {
    const element = opener.current;
    return () => {
      if (element instanceof HTMLElement && element.isConnected) element.focus();
    };
  }, []);
  return <Modal title={title} onClose={onClose}>{children}</Modal>;
}
