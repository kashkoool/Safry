import { useEffect, useMemo, useState } from "react";
import {
  api, clearSession, getIdleTimeoutMs, getLastActivityAt, getLoginPortal, getStoredUser, isMfaChallenge,
  markActivity, mayHaveSession, onRemoteSignOut, restoreSession, type AuthUser
} from "../lib/api";
import { AuthContext, type AuthContextValue } from "./auth-context";

const PING_EVERY_MS = 30_000;
const ACTIVITY_THROTTLE_MS = 1_000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser());
  // The access token is memory-only: after a reload (or in a new tab) the HttpOnly refresh cookie resumes the session.
  const [loading, setLoading] = useState(() => !getStoredUser() && mayHaveSession());

  useEffect(() => {
    if (!loading) return;
    let live = true;
    void restoreSession()
      .then((restored) => { if (live) setUser(restored); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per mount; `loading` only gates the first run
  }, []);

  // Sign-out in another tab, or a page restored from the back/forward cache after sign-out, ends this view too.
  useEffect(() => {
    const dropLocalSession = () => { clearSession(); setUser(null); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted && !getStoredUser()) setUser(null); };
    window.addEventListener("pageshow", restored);
    const stop = onRemoteSignOut(dropLocalSession);
    return () => { window.removeEventListener("pageshow", restored); stop(); };
  }, []);

  useEffect(() => {
    if (!user) return;
    let timer: number | undefined;
    let pingTimer: number | undefined;
    let lastPing = 0;
    let lastSeen = 0;
    let live = true;
    const expire = () => {
      const portal = getLoginPortal();
      api.endServerSession(); // the cookie must not outlive the client's decision to sign out
      clearSession();
      setUser(null);
      const returnTo = window.location.pathname + window.location.search + window.location.hash;
      window.location.replace(`/login/${portal}?expired=1&returnTo=${encodeURIComponent(returnTo)}`);
    };
    const schedule = () => {
      window.clearTimeout(timer);
      const remaining = getIdleTimeoutMs() - (Date.now() - getLastActivityAt());
      if (remaining <= 0) { expire(); return; }
      timer = window.setTimeout(expire, remaining);
    };
    const activity = () => {
      const now = Date.now();
      if (now - lastSeen < ACTIVITY_THROTTLE_MS) return; // wheel/touch/key bursts: no storage or timer work
      lastSeen = now;
      if (now - getLastActivityAt() >= getIdleTimeoutMs()) { expire(); return; }
      markActivity();
      schedule();
      if (now - lastPing >= PING_EVERY_MS) {
        lastPing = now;
        window.clearTimeout(pingTimer);
        pingTimer = window.setTimeout(() => {
          // A failed ping (offline, 5xx) must not sign the user out; a rejected session already fires session-expired.
          if (live) void api.activity().catch(() => undefined);
        }, 500);
      }
    };
    const passive = { passive: true } as const;
    window.addEventListener("pointerdown", activity, passive);
    window.addEventListener("keydown", activity, passive);
    window.addEventListener("wheel", activity, passive);
    window.addEventListener("touchstart", activity, passive);
    window.addEventListener("focus", schedule);
    window.addEventListener("safry:session-expired", expire);
    schedule();
    return () => {
      live = false;
      window.clearTimeout(timer);
      window.clearTimeout(pingTimer);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      window.removeEventListener("wheel", activity);
      window.removeEventListener("touchstart", activity);
      window.removeEventListener("focus", schedule);
      window.removeEventListener("safry:session-expired", expire);
    };
  }, [user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      login: async (input) => {
        const result = await api.login(input);
        if (isMfaChallenge(result)) return result;
        setUser(result.user);
        return null;
      },
      verifyMfa: async (mfaToken, code, portal) => {
        const session = await api.verifyMfa(mfaToken, code, portal);
        setUser(session.user);
      },
      logout: async () => {
        try {
          await api.logout();
        } finally {
          setUser(null);
        }
      }
    }),
    [user, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
