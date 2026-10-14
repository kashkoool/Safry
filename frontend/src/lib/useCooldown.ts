import { useCallback, useEffect, useState } from "react";
import { retryAfterOf } from "./errors";

/**
 * Whole seconds left before a mailed-link action may be repeated. `start(seconds)` begins a wait (the resend cooldown
 * after a successful request); `note(reason)` starts one from a 429 response's Retry-After.
 */
export function useCooldown(): { remaining: number; start: (seconds: number) => void; note: (reason: unknown) => void } {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!until) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) setUntil(0);
    }, 500);
    return () => window.clearInterval(timer);
  }, [until]);
  const start = useCallback((seconds: number) => {
    const current = Date.now();
    setNow(current);
    setUntil(current + seconds * 1000);
  }, []);
  const note = useCallback((reason: unknown) => {
    const seconds = retryAfterOf(reason);
    if (seconds) start(seconds);
  }, [start]);
  return { remaining: until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0, start, note };
}
