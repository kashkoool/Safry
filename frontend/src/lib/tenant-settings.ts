import type { TenantSettings } from "./tenant-admin";

/** Currencies the product prices in; the API accepts any ISO 4217 code, the UI offers only these. */
export const tenantCurrencies = ["TRY", "SYP", "SAR", "USD", "EUR", "EGP"] as const;
export const tenantLocales = ["ar-SA", "en-US"] as const;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const isHexColor = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

/** `#rgb` -> `#rrggbb`, which is the only form `<input type="color">` accepts. */
export function fullHex(value: string): string {
  return value.length === 4 ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}` : value;
}

/** Black or white, whichever reads better on the given background (WCAG relative luminance). */
export function readableTextOn(background: string): "#000000" | "#ffffff" {
  const hex = fullHex(background).slice(1);
  const channel = (offset: number): number => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

/**
 * The page's CSP allows images only from its own origin (and data: URIs), so a logo URL is rendered only when it is
 * served from this origin. Anything else is reported as null and the UI falls back to the initials.
 */
export function sameOriginLogo(url: unknown, origin: string = window.location.origin): string | null {
  if (typeof url !== "string" || !url) return null;
  try {
    const parsed = new URL(url, origin);
    if (parsed.protocol === "data:") return url;
    return parsed.origin === origin && (parsed.protocol === "https:" || parsed.protocol === "http:") ? parsed.href : null;
  } catch {
    return null;
  }
}

export function supportedTimeZones(): string[] {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    return zones.filter((zone) => zone.length <= 64);
  } catch {
    return [];
  }
}

/** The tenant's IANA time zone when it is valid in this browser, else undefined (the browser's own zone). */
export function validTimeZone(settings: TenantSettings | undefined): string | undefined {
  const zone = settings?.timezone;
  if (typeof zone !== "string" || !zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]!.charAt(0) + words[1]!.charAt(0) : (words[0] ?? "").slice(0, 2)).toUpperCase();
}
