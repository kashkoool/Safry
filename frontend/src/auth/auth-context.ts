import { createContext, useContext } from "react";
import type { AuthUser, LoginInput, MfaChallenge } from "../lib/api";

export interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** Resolves with an MFA challenge (no session yet) or null once signed in. */
  login: (input: LoginInput) => Promise<MfaChallenge | null>;
  verifyMfa: (mfaToken: string, code: string, portal: LoginInput["portal"]) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
