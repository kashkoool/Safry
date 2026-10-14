import { request } from "./api";

export type ProfileLocale = "ar-SA" | "en-US";
export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  phone: string | null;
  locale: ProfileLocale | string;
  status: string;
  emailVerifiedAt: string | null;
  mfaEnabledAt: string | null;
  createdAt: string;
}
export interface ProfileChanges {
  displayName?: string;
  phone?: string | null;
  locale?: ProfileLocale;
}
export interface MfaSetup {
  /** Base32 shared secret. Shown once on the setup screen, never stored or logged. */
  secret: string;
  otpauthUri: string;
}

// Calls that carry a password or one-time code pass `allowRefresh=false`: a 401 there means "wrong secret", and
// rotating the session to replay a guess would only hide that.
export const account = {
  profile: () => request<UserProfile>("/users/me"),
  updateProfile: (changes: ProfileChanges) =>
    request<UserProfile>("/users/me", { method: "PATCH", body: JSON.stringify(changes) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }, false),
  mfaSetup: (password: string) =>
    request<MfaSetup>("/auth/mfa/setup", { method: "POST", body: JSON.stringify({ password }) }, false),
  mfaEnable: (code: string) =>
    request<{ recoveryCodes: string[] }>("/auth/mfa/enable", { method: "POST", body: JSON.stringify({ code }) }),
  mfaDisable: (password: string, code: string) =>
    request<void>("/auth/mfa/disable", { method: "POST", body: JSON.stringify({ password, code }) }, false)
};
