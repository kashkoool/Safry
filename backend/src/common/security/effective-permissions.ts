/**
 * Platform authority comes only from `users.isPlatformAdmin` (PlatformAdminGuard). A `platform.*`
 * code is therefore never part of a membership's effective permissions, whether it arrives through
 * a role or an override.
 */
const PLATFORM_PREFIX = "platform.";

export function effectivePermissions(base: string[], overrides: unknown): string[] {
  const result = new Set(base);
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const [code, allowed] of Object.entries(overrides)) {
      if (allowed === true) result.add(code);
      if (allowed === false) result.delete(code);
    }
  }
  return [...result].filter((code) => !code.startsWith(PLATFORM_PREFIX)).sort();
}
