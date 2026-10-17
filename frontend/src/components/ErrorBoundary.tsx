import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, reloadOnceForStaleChunk } from "../lib/chunk-reload";

interface State { failed: boolean; reloading: boolean }

/** Read straight from storage: this boundary sits above the language provider, which may itself be what failed. */
function storedLanguage(): "ar" | "en" {
  try { return window.localStorage.getItem("safry.language") === "en" ? "en" : "ar"; } catch { return "ar"; }
}

/**
 * Last line of defence: a render error or a missing lazy chunk would otherwise unmount the whole app to a blank page.
 * Shows a translated message and a reload button, never the error text. A stale chunk after a deploy reloads once on its own.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, reloading: false };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, reloading: isChunkLoadError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isChunkLoadError(error) && reloadOnceForStaleChunk()) return;
    this.setState({ reloading: false });
    // Class only, as on the server: the message can hold data from the page.
    console.error(`Render failure: ${error instanceof Error ? error.constructor.name : "non-error"} (${info.componentStack?.length ?? 0} stack characters)`);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.state.reloading) return <main className="status-screen" role="status" aria-busy="true" />;
    const language = storedLanguage();
    const pick = (arabic: string, english: string): string => (language === "en" ? english : arabic);
    return (
      <main className="status-screen" role="alert" lang={language} dir={language === "en" ? "ltr" : "rtl"}>
        <h1>{pick("حدث خطأ غير متوقع", "Something went wrong")}</h1>
        <p>{pick("تعذر عرض هذه الصفحة. أعد تحميلها، وإذا استمرت المشكلة فحاول لاحقاً.", "This page could not be shown. Reload it, and if the problem continues try again later.")}</p>
        <button type="button" className="status-screen__action" onClick={() => window.location.reload()}>{pick("إعادة تحميل الصفحة", "Reload the page")}</button>
      </main>
    );
  }
}
