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

export function purgeStatements(env: Record<string, string | undefined>): string[] {
  const integer = (name: string, fallback: string, min: number, max: number): string => {
    const value = env[name] || fallback;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
    if (Number(value) < min || Number(value) > max) throw new Error(`${name} must be from ${min} to ${max}`);
    return value;
  };
  const sessions = integer("SESSION_RETENTION_DAYS", "30", 1, 3650);
  const tokens = integer("CREDENTIAL_TOKEN_RETENTION_DAYS", "7", 1, 3650);
  const throttles = integer("LOGIN_THROTTLE_RETENTION_HOURS", "24", 1, 720);
  const pending = integer("BOOKING_PENDING_TTL_HOURS", "48", 1, 720);
  const ahead = integer("AUDIT_PARTITIONS_AHEAD", "6", 1, 60);
  const batch = integer("PURGE_BATCH_SIZE", "5000", 100, 100_000);
  const audit = env["AUDIT_RETENTION_DAYS"] ? `${integer("AUDIT_RETENTION_DAYS", "", 30, 3650)} days` : "24 months";
  return [
    `CALL ensure_audit_event_partitions(0, ${ahead})`,
    `CALL purge_refresh_sessions(interval '${sessions} days', ${batch})`,
    `CALL purge_credential_tokens(interval '${tokens} days', ${batch})`,
    `CALL purge_login_throttles(interval '${throttles} hours', ${batch})`,
    `CALL sweep_expired_bookings(interval '${pending} hours', ${batch})`,
    `CALL purge_audit_events(interval '${audit}')`,
    "CALL record_maintenance_run('purge')"
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
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && !args.includes("--allow-remote")) {
    console.error(`Refusing to purge "${host}" from this helper; use backend/scripts/db/purge.sh there (or pass --allow-remote).`);
    return 1;
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
