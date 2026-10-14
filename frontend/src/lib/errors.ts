import { ApiError } from "./api";

type Pick = (arabic: string, english: string) => string;
type Translate = <T>(value: T) => T;

export interface ErrorOptions {
  /** Shown for a 401 on a call where 401 means "wrong password or code" (those calls never refresh the session). */
  wrongSecret?: string;
  /** Show the server's own sentence for a 401 (sign-in explains WHY it refused: bad credentials, wrong portal, expired challenge). */
  serverTextFor401?: boolean;
  /** Shown when the failure is not an `ApiError` or carries no usable text. */
  fallback?: string;
}

/**
 * One place that turns a failed call into text for the user, by status. Server text is kept for 400/409/422 (it names
 * the rule that was broken) and translated through the dictionary; everything else gets a fixed, translated sentence.
 */
export function errorText(reason: unknown, pick: Pick, tr: Translate, options: ErrorOptions = {}): string {
  const fallback = options.fallback ?? pick("تعذر إكمال الطلب.", "The request could not be completed.");
  if (!(reason instanceof ApiError)) return fallback;
  switch (reason.status) {
    case 0:
      return pick("تعذر الاتصال بالخادم. تحقق من اتصالك وحاول مجدداً.", "Could not reach the server. Check your connection and try again.");
    case 401:
      if (options.serverTextFor401 && reason.message) return tr(reason.message);
      return options.wrongSecret ?? pick("انتهت جلستك. سجّل الدخول من جديد.", "Your session has ended. Sign in again.");
    case 403:
      return pick("ليست لديك صلاحية لتنفيذ هذا الإجراء.", "You do not have permission to do this.");
    case 429:
      return pick("محاولات كثيرة. انتظر قليلاً ثم حاول مجدداً.", "Too many attempts. Wait a moment, then try again.");
    case 400:
    case 409:
    case 422:
      return reason.message ? tr(reason.message) : fallback;
    default:
      return reason.status >= 500
        ? pick("حدث خطأ في الخادم. حاول لاحقاً.", "Something went wrong on our side. Try again later.")
        : reason.message ? tr(reason.message) : fallback;
  }
}

/** Seconds the server asked us to wait, when the failure was a throttle response. */
export function retryAfterOf(reason: unknown): number | undefined {
  return reason instanceof ApiError && reason.status === 429 ? reason.retryAfter ?? 30 : undefined;
}
