import { useEffect, useState } from "react";
import { takeFragmentToken } from "../../lib/credentials";

// Module memory only (never storage). Survives the dev-only double mount of React StrictMode, which would otherwise
// find the address bar already cleaned and lose the token.
let held: string | null = null;
let release: number | undefined;

/** Captures the `#token=` fragment once, removes it from the address bar, and keeps the value in memory. */
export function useFragmentToken(): { token: string | null; forget: () => void } {
  const [token, setToken] = useState<string | null>(() => {
    const fresh = takeFragmentToken();
    if (fresh) held = fresh;
    return held;
  });
  useEffect(() => {
    window.clearTimeout(release);
    return () => {
      // Leaving the page drops the token; the timer lets a StrictMode remount cancel this before it runs.
      release = window.setTimeout(() => { held = null; }, 0);
    };
  }, []);
  return { token, forget: () => { held = null; setToken(null); } };
}
