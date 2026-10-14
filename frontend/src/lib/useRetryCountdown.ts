import { useCallback, useEffect, useState } from "react";
import { retryAfterOf } from "./errors";

/**
 * Counts down the wait a throttled (429) response asked for. `note(reason)` starts it when the failure was a throttle;
 * `remaining` is whole seconds left (0 = free to retry). Forms disable their submit button while it is above 0.
 */
export function useRetryCountdown(): { remaining: number; note: (reason: unknown) => void } {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!until) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) setUntil(0);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  const note = useCallback((reason: unknown) => {
    const seconds = retryAfterOf(reason);
    if (!seconds) return;
    const current = Date.now();
    setNow(current);
    setUntil(current + seconds * 1000);
  }, []);
  return { remaining: until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0, note };
}
