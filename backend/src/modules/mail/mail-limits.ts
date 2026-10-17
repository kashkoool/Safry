/** Pool names, default limits and env key names of the mail budget. No imports, so configuration validation can use it. */
/**
 * registration: verification mail triggered by an anonymous sign-up (new accounts); reset: reset and resend mail for EXISTING accounts;
 * security: notices an account owner needs. Separate pools so a flood of sign-ups can not use up the reset mail of real users.
 */
export type MailPool = "registration" | "reset" | "security";
export const MAIL_POOLS: readonly MailPool[] = ["registration", "reset", "security"];
/** Per-client-address daily caps: sign-ups, and reset/resend requests. */
export type AddressScope = "registration" | "reset";
export const ADDRESS_SCOPES: readonly AddressScope[] = ["registration", "reset"];


export interface PoolLimit { hour: number; day: number }
/** Defaults: hourly 10+15+5 = 30 and daily 40+45+15 = 100, which together fit the Resend free tier (100 mails a day). */
export const MAIL_POOL_DEFAULTS: Record<MailPool, PoolLimit> = { registration: { hour: 10, day: 40 }, reset: { hour: 15, day: 45 }, security: { hour: 5, day: 15 } };
export const MAIL_ADDRESS_DEFAULTS: Record<AddressScope, number> = { registration: 10, reset: 10 };

export const poolEnvKeys = (pool: MailPool): { hour: string; day: string } => ({ hour: `MAIL_BUDGET_${pool.toUpperCase()}_PER_HOUR`, day: `MAIL_BUDGET_${pool.toUpperCase()}_PER_DAY` });
export const addressEnvKey = (scope: AddressScope): string => `MAIL_ADDRESS_${scope.toUpperCase()}_PER_DAY`;

