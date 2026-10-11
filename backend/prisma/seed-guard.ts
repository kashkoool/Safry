import { isPlaceholder } from "../src/config/placeholders.js";

const MIN_PASSWORD_LENGTH = 12;

function readPassword(name: string): string {
  const value = process.env[name];
  if (!value || value.length < MIN_PASSWORD_LENGTH || isPlaceholder(value))
    throw new Error(`${name} must be set to a real password of at least ${MIN_PASSWORD_LENGTH} characters (not a placeholder). Generate one with: openssl rand -base64 18`);
  return value;
}

/** The seed creates known demo accounts, so it is opt-in and refuses to touch a production database by accident. */
export function assertSeedAllowed(): void {
  if (process.env["NODE_ENV"] === "production" && process.env["ALLOW_DEMO_SEED_IN_PRODUCTION"] !== "true")
    throw new Error("Refusing to seed with NODE_ENV=production. Set ALLOW_DEMO_SEED_IN_PRODUCTION=true only if you really intend to.");
}

export const adminPassword = (): string => readPassword("BOOTSTRAP_ADMIN_PASSWORD");
export const demoPassword = (): string => readPassword("DEMO_SEED_PASSWORD");
