import { cached, clearCache, invalidate } from "./cache";
export interface AuthUser {
  isPlatformAdmin?: boolean;
  /** Present on GET /auth/me; false means a platform administrator who must enrol two-factor first. */
  mfaEnabled?: boolean;
  userId: string;
  tenantId: string;
  membershipId: string;
  providerOrganizationId?: string | null;
  email: string;
  roles: string[];
  permissions: string[];
}

export interface Tenant {
  id: string;
  code: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** The refresh token is never visible to script: it lives in an HttpOnly cookie. */
export interface TokenPair {
  accessToken: string;
  expiresIn: number;
  idleTimeoutSeconds: number;
  user: AuthUser;
}

export interface LoginInput {
  email: string;
  password: string;
  tenantCode: string;
  portal?: "customer" | "provider" | "admin";
}
export interface RegistrationInput {
  displayName: string;
  email: string;
  password: string;
  tenantCode: string;
  organizationName?: string;
  organizationNameEn?: string;
  type?: ProviderType;
  city?: string;
  phone?: string;
  licenseNumber?: string;
}

export type ServiceCategory =
  "FLIGHT" | "HOTEL" | "TRANSPORT" | "TOUR" | "OTHER" | "UMRAH" | "PACKAGE" | "RESTAURANT" | "VISA" | "VISIT";
export const supportedCurrencies = ["TRY", "SYP", "SAR", "USD", "EUR", "EGP"] as const;
export type SupportedCurrency = typeof supportedCurrencies[number];
export const currencyNames: Record<SupportedCurrency, string> = {
  TRY: "ليرة تركية", SYP: "ليرة سورية جديدة", SAR: "ريال سعودي",
  USD: "دولار أمريكي", EUR: "يورو", EGP: "جنيه مصري"
};
export interface ExchangeRates {
  base: "USD";
  source: string;
  fetchedAt: string;
  rates: Record<SupportedCurrency, { rate: number; date: string }>;
}
export type ProviderType =
  | "UMRAH_COMPANY"
  | "TRAVEL_COMPANY"
  | "HOTEL"
  | "AIRLINE"
  | "TRANSPORT"
  | "RESTAURANT"
  | "VISA"
  | "VISIT"
  | "OTHER";
export interface Organization {
  id: string;
  name: string;
  nameAr?: string;
  nameEn?: string;
  type: ProviderType;
  city: string;
  contactEmail: string;
  phone: string;
  licenseNumber?: string;
  status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  _count?: { services: number; members: number };
}
export interface WorkspaceMetadata {
  organization: Organization | null;
  providerDefinitions: Record<ProviderType, { label: string; categories: ServiceCategory[]; role: string }>;
  serviceDefinitions: Record<
    ServiceCategory,
    {
      label: string;
      unit: string;
      dateLabel: string;
      fields: Array<{ key: string; label: string; required?: boolean; type?: "date" | "number" }>;
    }
  >;
}
export interface ServiceInput {
  title: string;
  titleEn?: string;
  descriptionEn?: string;
  cityEn?: string;
  detailsEn?: Record<string, string>;
  description: string;
  category: ServiceCategory;
  city: string;
  priceCents: number;
  currency: SupportedCurrency;
  capacity: number;
  details: Record<string, string>;
  componentIds: string[];
  providerOrganizationId?: string;
}
export interface BookingInput {
  serviceId: string;
  travelersCount: number;
  units?: number;
  serviceDate: string;
  endDate?: string;
  notes?: string;
}
export interface ProviderInput {
  name: string;
  nameAr: string;
  nameEn: string;
  type: ProviderType;
  city: string;
  contactEmail: string;
  phone: string;
  licenseNumber: string;
  password: string;
}
export type BookingStatus = "PENDING" | "CONFIRMED" | "CANCELLED";

export interface TravelService {
  id: string;
  title: string;
  titleAr?: string;
  titleEn?: string;
  descriptionAr?: string;
  descriptionEn?: string;
  cityAr?: string;
  cityEn?: string;
  detailsAr?: Record<string, string>;
  detailsEn?: Record<string, string>;
  description: string;
  category: ServiceCategory;
  city: string;
  priceCents: number;
  currency: SupportedCurrency;
  status: "DRAFT" | "ACTIVE" | "INACTIVE";
  capacity: number;
  details: Record<string, string>;
  organization: Pick<Organization, "id" | "name" | "nameAr" | "nameEn" | "type" | "status">;
  components: Array<{
    serviceId: string;
    service: {
      id: string;
      title: string;
      category: ServiceCategory;
      status: string;
      organization: { name: string };
    };
  }>;
}

export interface Booking {
  id: string;
  travelersCount: number;
  totalCents: number;
  unitPriceCents: number;
  units: number;
  serviceDate: string;
  endDate: string | null;
  currency: SupportedCurrency;
  status: BookingStatus;
  /** Set by the API when an unconfirmed pending booking timed out; it is reported as CANCELLED. */
  expired?: boolean;
  notes?: string;
  createdAt: string;
  service: TravelService;
  traveler?: { user: { displayName: string; email: string } };
}

export interface TenantMember {
  id: string;
  status: "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  jobTitle?: string;
  createdAt: string;
  user: { id: string; email: string; displayName: string; phone?: string; status: string };
  roles: Array<{ role: { code: string; name: string } }>;
}

export interface Invitation {
  id: string;
  jobTitle: string | null;
  createdAt: string;
  tenant: { code: string; name: string };
  organization: { name: string; nameAr: string | null; nameEn: string | null } | null;
}

export interface AuthSessionInfo {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  signedInAt: string;
  lastUsedAt: string | null;
  tenantId: string;
}
export interface MfaStatus {
  enabled: boolean;
  pendingSetup: boolean;
  recoveryCodesRemaining: number;
  recoveryCodesRegenerationRequired: boolean;
}
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  expiresIn: number;
}
export type LoginResult = TokenPair | MfaChallenge;
export function isMfaChallenge(result: LoginResult): result is MfaChallenge {
  return "mfaRequired" in result && result.mfaRequired === true;
}

interface ApiErrorBody {
  message?: string | string[];
  /** Stable machine code, e.g. `mfa_enrollment_required`. */
  code?: string;
  requestId?: string;
}

/** Error whose message is always safe to show to a user (never server internals). */
export class ApiError extends Error {
  readonly status: number;
  /** Seconds the server asked the client to wait (`Retry-After` on a 429); undefined otherwise. */
  readonly retryAfter?: number;
  /** Stable lower-snake-case machine code from the API, when it sent one. */
  readonly code?: string;
  constructor(status: number, message: string, retryAfter?: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

const API_URL = import.meta.env.VITE_API_URL ?? "/api/v1";
// Same-origin behind nginx / the Vite proxy needs no extra setting; an absolute API_URL (other origin) must send the cookie.
const CREDENTIALS: RequestCredentials = /^https?:\/\//i.test(API_URL) ? "include" : "same-origin";
/** Custom header the API requires on cookie-authenticated calls (CSRF defence next to SameSite=Strict + Origin check). */
const CSRF_HEADERS = { "x-requested-with": "XMLHttpRequest" } as const;
const ACTIVITY_KEY = "safry.lastActivityAt";
const PORTAL_KEY = "safry.loginPortal";
/** Non-secret hint ("a cookie session probably exists") so signed-out visitors do not probe /auth/refresh on every load. */
const HINT_KEY = "safry.hasSession";
let sessionEpoch = 0;
const ACTIVITY_WRITE_EVERY_MS = 5_000;
const GENERIC_ERROR = "تعذر إكمال الطلب";
const SERVER_ERROR = "Internal server error";
const NETWORK_ERROR = "Failed to fetch";
// Validation text such as "email must be an email" is user facing; stack traces, SQL and paths are not.
const INTERNALS = /\n|prisma|node_modules|\.[cm]?[jt]s:\d+|\bat\s+\S+\s+\(|\bECONN|\bSELECT\b|\bINSERT\b|\bUPDATE\b/i;

let lastActivityMemory: number | null = null;
let lastActivityWritten = 0;
/** The access token and user live in memory only (lost on reload, re-obtained through the cookie). */
let memorySession: TokenPair | null = null;

function readSession(): TokenPair | null {
  return memorySession;
}

function setHint(on: boolean): void {
  try {
    if (on) localStorage.setItem(HINT_KEY, "1");
    else localStorage.removeItem(HINT_KEY);
  } catch { /* storage unavailable: the hint is only an optimisation */ }
}

/** True when a previous visit left a session cookie behind that is worth trying to resume. */
export function mayHaveSession(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return true;
  }
}

export function saveSession(session: TokenPair, resetActivity = false, portal?: LoginInput["portal"]): void {
  memorySession = session;
  setHint(true);
  if (resetActivity) {
    lastActivityMemory = Date.now();
    lastActivityWritten = lastActivityMemory;
    sessionStorage.setItem(ACTIVITY_KEY, String(lastActivityMemory));
  }
  if (portal) sessionStorage.setItem(PORTAL_KEY, portal);
}

/** Removes every piece of client-side session state and cached API data. The portal hint is a UI preference only. */
export function clearSession(): void {
  memorySession = null;
  setHint(false);
  sessionStorage.removeItem(ACTIVITY_KEY);
  lastActivityMemory = null;
  lastActivityWritten = 0;
  sessionEpoch += 1; // a refresh that started before this point must not write a session back
  clearCache();
}

export function getLastActivityAt(): number {
  lastActivityMemory ??= Number(sessionStorage.getItem(ACTIVITY_KEY)) || Date.now();
  return lastActivityMemory;
}

/** Cheap in-memory update; the storage write (needed only to survive a reload) is throttled. */
export function markActivity(): void {
  const now = Date.now();
  lastActivityMemory = now;
  if (now - lastActivityWritten >= ACTIVITY_WRITE_EVERY_MS) {
    lastActivityWritten = now;
    sessionStorage.setItem(ACTIVITY_KEY, String(now));
  }
}

export function getIdleTimeoutMs(): number {
  return (readSession()?.idleTimeoutSeconds || 900) * 1000;
}

export function getLoginPortal(): LoginInput["portal"] {
  return (sessionStorage.getItem(PORTAL_KEY) as LoginInput["portal"]) || "customer";
}

export function getStoredUser(): AuthUser | null {
  return readSession()?.user ?? null;
}

// Cross-tab sign-out: other tabs of the same user drop their copy of the session too.
const authChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("safry-auth");
export function broadcastSignOut(userId: string | undefined): void {
  authChannel?.postMessage({ type: "signed-out", userId });
}
export function onRemoteSignOut(handler: () => void): () => void {
  if (!authChannel) return () => undefined;
  const listener = (event: MessageEvent<{ type?: string; userId?: string }>) => {
    if (event.data?.type === "signed-out" && event.data.userId === getStoredUser()?.userId) handler();
  };
  authChannel.addEventListener("message", listener);
  return () => authChannel.removeEventListener("message", listener);
}

function safeMessage(status: number, body: ApiErrorBody): string {
  if (status >= 500) return SERVER_ERROR;
  const text = Array.isArray(body.message) ? body.message.join("، ") : body.message;
  if (typeof text !== "string" || !text || text.length > 300 || INTERNALS.test(text)) return GENERIC_ERROR;
  return text;
}

/** `Retry-After` is delta-seconds or an HTTP date; anything else (or a silly value) is ignored. Capped at one hour. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : undefined;
}

let signingOut = false;
let pendingRefresh: Promise<TokenPair | null> | null = null;
/**
 * Single-flight within this tab. Tabs share ONE cookie, so refreshes are also serialised across tabs with the Web Locks
 * API; the server's 10 s rotation grace plus one delayed retry cover browsers without it (and a refresh from another
 * tab that wins the race at the same instant).
 */
function refreshSession(): Promise<TokenPair | null> {
  pendingRefresh ??= withRefreshLock(performRefresh).finally(() => {
    pendingRefresh = null;
  });
  return pendingRefresh;
}
function withRefreshLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: { request: <R>(name: string, cb: () => Promise<R>) => Promise<R> } }).locks;
  return locks ? locks.request("safry-refresh", work) : work();
}
const RACE_RETRY_MS = 600;
const postRefresh = (): Promise<Response> =>
  fetch(`${API_URL}/auth/refresh`, { method: "POST", cache: "no-store", credentials: CREDENTIALS, headers: { ...CSRF_HEADERS } });
async function performRefresh(): Promise<TokenPair | null> {
  const previous = readSession();
  const epoch = sessionEpoch;
  let response: Response;
  try {
    response = await postRefresh();
    if (response.status === 401) {
      // Another tab may have rotated the shared cookie at the same instant: the loser is refused inside the grace
      // window without ending the family, and the browser now holds the winner's cookie.
      await new Promise((resolve) => setTimeout(resolve, RACE_RETRY_MS));
      if (epoch === sessionEpoch) response = await postRefresh();
    }
  } catch {
    return null; // transient network failure: keep the session, the caller reports the original error
  }
  if (!response.ok) {
    // Only a definitive rejection ends the session; a 5xx or 429 must not log the user out.
    if (response.status >= 400 && response.status < 500 && response.status !== 429 && epoch === sessionEpoch) {
      const userId = previous?.user.userId;
      clearSession();
      broadcastSignOut(userId);
      if (!signingOut) window.dispatchEvent(new Event("safry:session-expired"));
    }
    return null;
  }
  const next = (await response.json()) as TokenPair;
  if (epoch !== sessionEpoch) {
    // The session was cleared (logout, remote sign-out) while this refresh was in flight: do not bring it back. The
    // server already rotated and the browser holds the new cookie, so end that family (best effort), unless a fresh
    // sign-in has happened since (its cookie is the current one and must survive).
    if (!readSession()) {
      void fetch(`${API_URL}/auth/logout`, {
        method: "POST", cache: "no-store", credentials: CREDENTIALS, headers: { ...CSRF_HEADERS }
      }).catch(() => undefined);
    }
    return null;
  }
  saveSession(next);
  return next;
}

/** Resumes a session from the HttpOnly cookie after a reload / new tab. Resolves null when there is none. */
export async function restoreSession(): Promise<AuthUser | null> {
  const existing = readSession();
  if (existing) return existing.user;
  const next = await refreshSession();
  return next?.user ?? null;
}

/** Sends one authenticated call and returns the successful response; a failure becomes an `ApiError` with a safe message. */
async function send(path: string, init: RequestInit, allowRefresh: boolean): Promise<Response> {
  const session = readSession();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("x-requested-with", CSRF_HEADERS["x-requested-with"]);
  if (init.body) headers.set("content-type", "application/json");
  if (session) {
    headers.set("authorization", `Bearer ${session.accessToken}`);
    headers.set("x-tenant-id", session.user.tenantId);
  }

  let response: Response;
  try {
    // no-store: authenticated JSON (PII) must not be kept in the browser HTTP cache after logout.
    response = await fetch(`${API_URL}${path}`, { ...init, headers, cache: "no-store", credentials: CREDENTIALS });
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
    throw new ApiError(0, NETWORK_ERROR);
  }
  if (response.status === 401 && allowRefresh && session) {
    // Late 401 from a request sent before an already-finished refresh: reuse the new token, do not rotate again.
    const latest = readSession();
    const renewed = latest && latest.accessToken !== session.accessToken ? latest : await refreshSession();
    if (renewed) return send(path, init, false); // at most one retry
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    const wait = response.status === 429 ? parseRetryAfter(response.headers.get("retry-after")) : undefined;
    throw new ApiError(response.status, safeMessage(response.status, body), wait, safeErrorCode(body.code));
  }
  return response;
}

/** Machine code of an error response: letters, digits and underscore only (lower case such as mfa_enrollment_required or upper case such as BOOKING_EXPIRED), at most 64 characters; anything else is dropped. */
export function safeErrorCode(code: unknown): string | undefined {
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : undefined;
}

export async function request<T>(path: string, init: RequestInit = {}, allowRefresh = true): Promise<T> {
  const response = await send(path, init, allowRefresh);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface Page<T> {
  items: T[];
  /** Opaque keyset cursor of the next page; null when this was the last one. */
  nextCursor: string | null;
}
/** GET for keyset-paged list endpoints: the body is a plain array and `X-Next-Cursor` is present only while more rows exist. */
export async function requestPage<T>(path: string, init: RequestInit = {}): Promise<Page<T>> {
  const response = await send(path, init, true);
  const items = (await response.json()) as T[];
  return { items, nextCursor: response.headers.get("x-next-cursor") || null };
}

const seg = encodeURIComponent;
/** The API caps list endpoints at this many rows per request; the next rows are fetched with the cursor it hands back. */
export const PAGE_SIZE = 100;
const pageQuery = (cursor?: string | null) => `?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
const TTL = 30_000;
// Cache keys are scoped to the signed-in user and tenant so data can never be served across identities.
export const cacheScope = () => {
  const user = readSession()?.user;
  return user ? `${user.userId}:${user.tenantId}:` : "anon:";
};
export const read = <T>(key: string, load: () => Promise<T>, ttl = TTL) => cached(cacheScope() + key, ttl, load);
export const afterWrite = <T>(prefixes: string[], work: Promise<T>): Promise<T> => {
  const prefix = cacheScope();
  return work.finally(() => invalidate(...prefixes.map((p) => prefix + p)));
};

export const api = {
  register: (kind: "customer" | "provider", input: RegistrationInput) =>
    request<{ message: string }>(`/auth/register/${seg(kind)}`, {
      method: "POST", body: JSON.stringify(input)
    }, false),
  async login(input: LoginInput): Promise<LoginResult> {
    clearCache();
    const response = await request<LoginResult>(
      "/auth/login",
      { method: "POST", body: JSON.stringify(input) },
      false
    );
    // An MFA challenge is not a session: nothing is stored until the second factor is verified.
    if (!isMfaChallenge(response)) saveSession(response, true, input.portal);
    return response;
  },
  async verifyMfa(mfaToken: string, code: string, portal?: LoginInput["portal"]): Promise<TokenPair> {
    const response = await request<TokenPair>(
      "/auth/mfa/verify",
      { method: "POST", body: JSON.stringify({ mfaToken, code }) },
      false
    );
    saveSession(response, true, portal);
    return response;
  },
  activity: () => request<void>("/auth/activity", { method: "POST" }),
  me: () => request<AuthUser>("/auth/me"),
  currentTenant: () => read("tenant", () => request<Tenant>("/tenants/current")),
  services: (cursor?: string | null) => read(`services:${cursor ?? ""}`, () => requestPage<TravelService>(`/services${pageQuery(cursor)}`)),
  exchangeRates: () => read("rates", () => request<ExchangeRates>("/services/exchange-rates"), 60 * 60_000),
  marketplace: (cursor?: string | null) => read(`marketplace:${cursor ?? ""}`, () => requestPage<TravelService>(`/services/marketplace${pageQuery(cursor)}`)),
  workspace: () => read("workspace", () => request<WorkspaceMetadata>("/providers/workspace")),
  providers: (cursor?: string | null) => read(`providers:${cursor ?? ""}`, () => requestPage<Organization>(`/providers${pageQuery(cursor)}`)),
  createProvider: (input: ProviderInput) =>
    afterWrite(["providers", "marketplace", "services", "workspace", "members"],
      request<Organization>("/providers", { method: "POST", body: JSON.stringify(input) })),
  updateProvider: (id: string, input: { name: string; nameAr: string; nameEn: string; city: string; phone: string; licenseNumber: string }) =>
    afterWrite(["providers", "marketplace", "services", "workspace"],
      request<Organization>(`/providers/${seg(id)}`, { method: "PATCH", body: JSON.stringify(input) })),
  providerStatus: (id: string, status: "ACTIVE" | "SUSPENDED") =>
    afterWrite(["providers", "marketplace", "services", "workspace"],
      request<Organization>(`/providers/${seg(id)}/status`, { method: "PATCH", body: JSON.stringify({ status }) })),
  createService: (input: ServiceInput) =>
    afterWrite(["services", "marketplace", "providers", "workspace"],
      request<TravelService>("/services", { method: "POST", body: JSON.stringify(input) })),
  updateService: (
    id: string,
    input: Partial<Omit<ServiceInput, "providerOrganizationId">> & { status?: TravelService["status"] }
  ) => afterWrite(["services", "marketplace", "providers", "workspace", "bookings"],
    request<TravelService>(`/services/${seg(id)}`, { method: "PATCH", body: JSON.stringify(input) })),
  bookings: (cursor?: string | null) => read(`bookings:${cursor ?? ""}`, () => requestPage<Booking>(`/bookings${pageQuery(cursor)}`)),
  /** `idempotencyKey` is one per user action: the same key on a retry returns the first booking, never a second one. */
  createBooking: (input: BookingInput, idempotencyKey: string) =>
    afterWrite(["bookings"], request<Booking>("/bookings", {
      method: "POST", body: JSON.stringify(input), headers: { "idempotency-key": idempotencyKey }
    })),
  sessions: () => request<AuthSessionInfo[]>("/auth/sessions"),
  mfaStatus: () => request<MfaStatus>("/auth/mfa"),
  regenerateRecoveryCodes: (password: string, code: string) =>
    request<{ recoveryCodes: string[] }>("/auth/mfa/recovery-codes", { method: "POST", body: JSON.stringify({ password, code }) }, false), // a wrong password/code is also 401: do not rotate the session and replay the guess
  endSession: (id: string) => request<void>(`/auth/sessions/${seg(id)}`, { method: "DELETE" }),
  updateBookingStatus: (id: string, status: "CONFIRMED" | "CANCELLED") =>
    afterWrite(["bookings"], request<Booking>(`/bookings/${seg(id)}/status`, { method: "PATCH", body: JSON.stringify({ status }) })),
  updateBooking: (id: string, input: Partial<Omit<BookingInput, "serviceId">>) =>
    afterWrite(["bookings"], request<Booking>(`/bookings/${seg(id)}`, { method: "PATCH", body: JSON.stringify(input) })),
  invitations: () => request<Invitation[]>("/users/me/invitations"),
  respondToInvitation: (id: string, accept: boolean) =>
    request<{ membershipId: string; status: string }>(
      `/users/me/invitations/${seg(id)}/${accept ? "accept" : "decline"}`, { method: "POST" }),
  members: () => read("members", () => request<TenantMember[]>("/tenants/members")),
  /**
   * Ends EVERY session of this account (all devices and workspaces, this one included). Local state is cleared only
   * after the server confirmed: a failed call leaves the user signed in and able to retry.
   */
  async logoutAll(): Promise<void> {
    const userId = readSession()?.user.userId;
    await request<void>("/auth/logout-all", { method: "POST" });
    clearSession();
    broadcastSignOut(userId);
  },
  /** Best effort, fire-and-forget: ends the cookie session and clears the cookie when the client gives up on a session on its own (idle timeout). */
  endServerSession(): void {
    void fetch(`${API_URL}/auth/logout`, { method: "POST", cache: "no-store", credentials: CREDENTIALS, headers: { ...CSRF_HEADERS } }).catch(() => undefined);
  },
  /**
   * Revokes the server session. The refresh cookie is sent automatically and needs no access token, so this works after
   * the access token expired; the server clears the cookie. Local state is always cleared.
   */
  async logout(): Promise<void> {
    const userId = readSession()?.user.userId;
    signingOut = true;
    try {
      await request<void>("/auth/logout", { method: "POST" }, false);
    } finally {
      signingOut = false;
      clearSession();
      broadcastSignOut(userId);
    }
  }
};
