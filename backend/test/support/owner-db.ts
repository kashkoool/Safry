import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";

const root = resolve(import.meta.dirname, "../..");
const prismaCli = resolve(root, "node_modules/prisma/build/index.js");

export function prismaCommand(args: string[], url: string, config?: string): string {
  return execFileSync(process.execPath, [prismaCli, ...args, ...(config ? ["--config", config] : [])], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url, DATABASE_MIGRATE_URL: url },
    stdio: "pipe"
  }).toString();
}

export interface OwnerDatabase {
  /** Connection URL of the NON-superuser, non-BYPASSRLS owner role (what a managed-Postgres owner looks like). */
  ownerUrl: string;
  /** Superuser URL of the same database, for fixtures and assertions. */
  adminUrl: string;
  ownerRole: string;
  drop: () => Promise<void>;
}

/**
 * A fresh database owned by a LOGIN CREATEROLE role that is NOT a superuser and has NO BYPASSRLS, migrated as that
 * owner unless `migrate: false`. Used to prove migrations and operator scripts work for a real hosted owner login.
 */
export async function createOwnerDatabase(serverUrl: string, options: { migrate?: boolean } = {}): Promise<OwnerDatabase> {
  const stamp = randomUUID().replaceAll("-", "").slice(0, 12);
  const ownerRole = `fb_owner_${stamp}`;
  const database = `safry_owner_${stamp}`;
  const password = randomBytes(12).toString("hex");
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE ROLE ${ownerRole} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${ownerRole}`);
  const adminUrl = new URL(serverUrl);
  adminUrl.pathname = `/${database}`;
  const ownerUrl = new URL(adminUrl);
  ownerUrl.username = ownerRole;
  ownerUrl.password = password;
  if (options.migrate !== false) prismaCommand(["migrate", "deploy"], ownerUrl.toString());
  return {
    ownerUrl: ownerUrl.toString(),
    adminUrl: adminUrl.toString(),
    ownerRole,
    drop: async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`DROP OWNED BY ${ownerRole}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${ownerRole}`).catch(() => undefined);
      await admin.end();
    }
  };
}
