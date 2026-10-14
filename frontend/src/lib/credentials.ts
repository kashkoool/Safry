import { request } from "./api";

// Public credential endpoints: no session, no tenant header. Every call passes `allowRefresh=false` so a 401/400 is
// reported as-is and never triggers a session rotation. Tokens travel only in the JSON body.
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

export const credentials = {
  /** Always answers the same neutral "accepted", whether or not the address has an account. */
  forgotPassword: (email: string) =>
    request<{ accepted: boolean }>("/auth/password/forgot", { method: "POST", body: JSON.stringify({ email }) }, false),
  resetPassword: (token: string, newPassword: string) =>
    request<void>("/auth/password/reset", { method: "POST", body: JSON.stringify({ token, newPassword }) }, false),
  verifyEmail: (token: string) =>
    request<void>("/auth/email/verify", { method: "POST", body: JSON.stringify({ token }) }, false),
  resendVerification: (email: string) =>
    request<{ accepted: boolean }>("/auth/email/resend", { method: "POST", body: JSON.stringify({ email }) }, false)
};

/**
 * Reads `#token=...` from the address bar ONCE and removes the whole fragment with `history.replaceState`, so the
 * token is never kept in the URL, history entry, bookmark or a later link. Returns null when no usable token exists.
 * The caller must keep the value in memory only (never storage, never a log line, never a link).
 */
export function takeFragmentToken(): string | null {
  const hash = window.location.hash;
  if (!hash) return null;
  const value = new URLSearchParams(hash.slice(1)).get("token");
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  return value && TOKEN_PATTERN.test(value) ? value : null;
}

/** Strength hint that is computed locally and never leaves the page; it names a quality, never echoes the password. */
export type PasswordStrength = "short" | "weak" | "fair" | "strong";
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < PASSWORD_MIN) return "short";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  const distinct = new Set(password).size;
  if (distinct < 6 || classes < 2) return "weak";
  return password.length >= 16 && classes >= 3 ? "strong" : "fair";
}
