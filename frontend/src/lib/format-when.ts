import { currentLocale } from "../i18n/locale";

/** Date and time in the workspace time zone when it is valid, else in the browser zone. */
export function formatWhen(value: string, timeZone?: string): string {
  try {
    return new Date(value).toLocaleString(currentLocale(), { calendar: "gregory", ...(timeZone ? { timeZone } : {}) });
  } catch {
    return new Date(value).toLocaleString(currentLocale(), { calendar: "gregory" });
  }
}

