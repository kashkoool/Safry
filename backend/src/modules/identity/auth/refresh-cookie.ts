import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { CookieOptions, Request, Response } from "express";
import { corsOptions } from "../../../app.setup.js";

/**
 * Refresh-token transport (web: HttpOnly cookie; native clients opt in to the body model).
 *
 * Web (default): HttpOnly cookie, never in a body. Native clients opt in with `X-Client: mobile` and use the body;
 * that mode never reads a cookie, so script on a web page cannot trade the cookie for a readable token.
 */
export const CLIENT_HEADER = "x-client";
export const NATIVE_CLIENT = "mobile";
/** Custom header a cross-site form or image cannot add (a cross-origin fetch needs a CORS preflight, restricted to CORS_ORIGINS). */
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "XMLHttpRequest";

export type ClientKind = "web" | "native";

export const clientKind = (req: Request): ClientKind => (req.header(CLIENT_HEADER)?.trim().toLowerCase() === NATIVE_CLIENT ? "native" : "web");

export interface CookieSettings {
  name: string;
  path: string;
  secure: boolean;
}

/** `__Host-` needs Path=/, which would expose the cookie to every API route, so the narrow path wins and `__Secure-` is used. */
export function cookieSettings(prefix: string, production: boolean): CookieSettings {
  return {
    name: production ? "__Secure-safry_rt" : "safry_rt",
    path: `/${prefix.replace(/^\/+|\/+$/g, "")}/auth`,
    secure: production
  };
}

function baseOptions(settings: CookieSettings): CookieOptions {
  return { httpOnly: true, secure: settings.secure, sameSite: "strict", path: settings.path };
}

export function setRefreshCookie(res: Response, settings: CookieSettings, token: string, expiresAt: Date, now = Date.now()): void {
  const maxAge = Math.max(0, expiresAt.getTime() - now);
  res.cookie(settings.name, token, { ...baseOptions(settings), maxAge });
}

export function clearRefreshCookie(res: Response, settings: CookieSettings): void {
  res.clearCookie(settings.name, baseOptions(settings));
}

/**
 * Reads one cookie from the Cookie header without a parser dependency. A second cookie with the same name is an invalid
 * request: a sibling subdomain can plant a same-name cookie (cookie tossing) and browsers send it before or
 * after the real one, so neither "first wins" nor "last wins" is trustworthy. The caller answers 401 and clears nothing.
 * (`__Host-` would stop tossing, but it requires Path=/, which would send the cookie to every API route.)
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  let found: string | undefined;
  let seen = 0;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    seen += 1;
    if (seen > 1) throw new UnauthorizedException("Refresh token is invalid or expired");
    const value = part.slice(index + 1).trim();
    try {
      found = value === "" ? undefined : decodeURIComponent(value);
    } catch {
      found = undefined;
    }
  }
  return found;
}

/**
 * CSRF defence for cookie-authenticated requests, on top of SameSite=Strict:
 * a present Origin must be a configured CORS origin or the request's own host (same-origin behind nginx), and
 * state-changing cookie endpoints need the custom header. Requests with no Origin (curl, server-to-server)
 * carry no ambient browser credentials, so they pass the Origin test.
 */
export function assertBrowserRequest(req: Request, corsRaw: string | undefined, production: boolean, requireCsrfHeader: boolean): void {
  const origin = req.header("origin");
  if (origin !== undefined && !originAllowed(origin, req.header("host"), req.protocol, corsRaw, production)) throw new ForbiddenException("Origin not allowed");
  if (requireCsrfHeader && req.header(CSRF_HEADER) !== CSRF_VALUE) throw new ForbiddenException("Missing CSRF header");
}

/** A configured origin matches as a whole string (scheme, host, port). Otherwise the origin must be this request's own origin: protocol (X-Forwarded-Proto only with TRUST_PROXY), host and port. */
function originAllowed(origin: string, host: string | undefined, protocol: string, corsRaw: string | undefined, production: boolean): boolean {
  const allowed = corsOptions(corsRaw, production).origin;
  if (allowed && allowed.includes(origin)) return true;
  if (!host) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.protocol === `${protocol}:` && url.host === host;
  } catch {
    return false;
  }
}
