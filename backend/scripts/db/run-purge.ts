/**
 * Runs the same maintenance procedures as purge.sh, through the Node pg driver, for machines without psql (for example Windows
 * with the embedded test PostgreSQL). Keep the CALL list in sync with purge.sh. Needs the owner connection.
 *
 *   pnpm db:purge-local -- --url postgresql://...        # SESSION_RETENTION_DAYS / AUDIT_RETENTION_DAYS / AUDIT_PARTITIONS_AHEAD apply
 *
 * Refuses a non-local host unless --allow-remote is given, because it deletes data.
 */
import { pathToFileURL } from "node:url";
import pg from "pg";
import { assertSafeTarget } from "../seed-history.js";

export function purgeStatements(env: Record<string, string | undefined>): string[] {
  const integer = (name: string, fallback: string): string => {
    const value = env[name] || fallback;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
    return value;
  };
  const sessions = integer("SESSION_RETENTION_DAYS", "30");
  const ahead = integer("AUDIT_PARTITIONS_AHEAD", "6");
  const auditDays = env["AUDIT_RETENTION_DAYS"] ? integer("AUDIT_RETENTION_DAYS", "") : undefined;
  // Same bounds as the procedures, checked before any of them runs (a late refusal would leave the first ones already applied).
  if (Number(sessions) < 1) throw new Error("SESSION_RETENTION_DAYS must be at least 1");
  if (Number(ahead) < 1 || Number(ahead) > 60) throw new Error("AUDIT_PARTITIONS_AHEAD must be between 1 and 60");
  if (auditDays !== undefined && Number(auditDays) < 30) throw new Error("AUDIT_RETENTION_DAYS must be at least 30");
  const audit = auditDays !== undefined ? `${auditDays} days` : "24 months";
  return [
    `CALL ensure_audit_event_partitions(0, ${ahead})`,
    `CALL purge_refresh_sessions(interval '${sessions} days')`,
    "CALL purge_credential_tokens(interval '7 days')",
    `CALL purge_audit_events(interval '${audit}')`
  ];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const urlIndex = args.indexOf("--url");
  const url = urlIndex >= 0 ? args[urlIndex + 1] : (process.env["DATABASE_MIGRATE_URL"] ?? process.env["DATABASE_URL"]);
  if (!url) {
    console.error("Give the owner database with --url or DATABASE_MIGRATE_URL.");
    return 1;
  }
  if (!args.includes("--allow-remote")) {
    try {
      assertSafeTarget({}, url);
    } catch (error) {
      console.error(`${error instanceof Error ? error.message : String(error)} Use backend/scripts/db/purge.sh for other hosts (or pass --allow-remote).`);
      return 1;
    }
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const sql of purgeStatements(process.env)) {
      const started = Date.now();
      await client.query(sql);
      console.log(`${sql}  (${Date.now() - started} ms)`);
    }
    console.log("purge done");
    return 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  );
