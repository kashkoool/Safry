import type { AuthUser } from "../../../common/security/auth-user.js";

export interface JwtPayload {
  av?: number;
  sid: string;
  sub: string;
  tid: string;
  mid: string;
  email: string;
  roles: string[];
  permissions: string[];
}

/** What a browser receives: the refresh token travels only in an HttpOnly cookie. */
export interface TokenPair {
  accessToken: string;
  expiresIn: number;
  idleTimeoutSeconds: number;
  user: AuthUser;
}

/** Native (non-browser) clients opt in with `X-Client: mobile` and get the refresh token in the body instead of a cookie. */
export interface NativeTokenPair extends TokenPair {
  refreshToken: string;
}

/** Service output: the controller decides, per client kind, where the refresh token goes. */
export interface IssuedTokenPair extends NativeTokenPair {
  refreshExpiresAt: Date;
}

/** Returned by login instead of a token pair when the account has multi-factor authentication enabled. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  expiresIn: number;
}

export type LoginResult = IssuedTokenPair | MfaChallenge;

/** Pinned signing parameters: one algorithm, and issuer/audience that differ per token type. */
export const ACCESS_TOKEN = { algorithm: "HS256", issuer: "safry-api", audience: "safry-access" } as const;
export const MFA_TOKEN = { algorithm: "HS256", issuer: "safry-api", audience: "safry-mfa-challenge" } as const;

export interface MfaTokenPayload {
  purpose: "mfa";
  jti?: string;
  sub: string;
  tid: string;
  mid: string;
  portal?: "customer" | "provider" | "admin" | undefined;
}
