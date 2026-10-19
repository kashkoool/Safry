/**
 * Read-only storage report: per table the row count, table (heap), TOAST and index size, dead rows, and the age of the oldest row.
 * The monthly audit_events partitions are rolled up into one line (use --partitions to list them).
 *
 *   pnpm db:size-report                       # uses DATABASE_MIGRATE_URL or DATABASE_URL
 *   pnpm db:size-report -- --url postgresql://... --json
 *
 * Only SELECTs are run. Row counts are exact (count(*)), so on a very large table the report takes a while.
 */
import { pathToFileURL } from "node:url";
import pg from "pg";

/** The column that dates a row, per table; tables not listed are reported without an age. */
export const AGE_COLUMN: Record<string, string> = {
  audit_events: "occurredAt",
  bookings: "createdAt",
  credential_tokens: "createdAt",
  login_throttles: "updatedAt",
  provider_organizations: "createdAt",
  refresh_sessions: "createdAt",
  tenant_memberships: "createdAt",
  tenants: "createdAt",
  travel_services: "createdAt",
  users: "createdAt"
};

export interface TableReport {
  table: string;
  rows: number;
  heapBytes: number;
  toastBytes: number;
  indexBytes: number;
  totalBytes: number;
  deadRows: number;
  oldest: string | null;
  oldestAgeDays: number | null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}

const GROUPS_SQL = `
  SELECT coalesce(parent.relname, c.relname)::text AS grp,
         sum(pg_relation_size(c.oid))::bigint AS heap,
         sum(CASE WHEN c.reltoastrelid <> 0 THEN pg_total_relation_size(c.reltoastrelid) ELSE 0 END)::bigint AS toast,
         sum(pg_indexes_size(c.oid))::bigint AS idx,
         sum(pg_total_relation_size(c.oid))::bigint AS total,
         coalesce(sum(s.n_dead_tup), 0)::bigint AS dead,
         count(*)::int AS parts
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
  LEFT JOIN pg_class parent ON parent.oid = i.inhparent
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE '\\_prisma%'
  GROUP BY 1
  ORDER BY total DESC`;

export async function collect(client: pg.Client, withPartitions = false): Promise<{ tables: TableReport[]; databaseBytes: number; partitions: Array<{ name: string; rows: number; bytes: number }> }> {
  const groups = await client.query<{ grp: string; heap: string; toast: string; idx: string; total: string; dead: string; parts: number }>(GROUPS_SQL);
  const tables: TableReport[] = [];
  for (const g of groups.rows) {
    const quoted = `"${g.grp.replaceAll('"', '""')}"`;
    const count = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${quoted}`);
    const column = AGE_COLUMN[g.grp];
    let oldest: string | null = null;
    let age: number | null = null;
    if (column) {
      const r = await client.query<{ oldest: Date | null }>(`SELECT min("${column}") AS oldest FROM public.${quoted}`);
      const value = r.rows[0]?.oldest ?? null;
      if (value) {
        oldest = value.toISOString();
        age = Math.floor((Date.now() - value.getTime()) / 86_400_000);
      }
    }
    tables.push({ table: g.grp, rows: Number(count.rows[0]!.n), heapBytes: Number(g.heap), toastBytes: Number(g.toast), indexBytes: Number(g.idx), totalBytes: Number(g.total), deadRows: Number(g.dead), oldest, oldestAgeDays: age });
  }
  const db = await client.query<{ size: string }>("SELECT pg_database_size(current_database())::text AS size");
  const partitions: Array<{ name: string; rows: number; bytes: number }> = [];
  if (!withPartitions) return { tables, databaseBytes: Number(db.rows[0]!.size), partitions };
  const parts = await client.query<{ name: string; bytes: string }>(
    `SELECT c.relname::text AS name, pg_total_relation_size(c.oid)::text AS bytes
     FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'public.audit_events'::regclass ORDER BY c.relname`
  );
  for (const p of parts.rows) {
    const n = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM public."${p.name}"`);
    partitions.push({ name: p.name, rows: Number(n.rows[0]!.n), bytes: Number(p.bytes) });
  }
  return { tables, databaseBytes: Number(db.rows[0]!.size), partitions };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const urlIndex = args.indexOf("--url");
  const url = urlIndex >= 0 ? args[urlIndex + 1] : (process.env["DATABASE_MIGRATE_URL"] ?? process.env["DATABASE_URL"]);
  if (!url) {
    console.error("Give the database with --url or DATABASE_URL.");
    return 1;
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SET default_transaction_read_only = on");
    const report = await collect(client, args.includes("--partitions"));
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    console.table(
      report.tables.map((t) => ({
        table: t.table,
        rows: t.rows,
        heap: formatBytes(t.heapBytes),
        toast: formatBytes(t.toastBytes),
        indexes: formatBytes(t.indexBytes),
        total: formatBytes(t.totalBytes),
        dead: t.deadRows,
        "oldest row": t.oldest ? t.oldest.slice(0, 10) : "-",
        "age (days)": t.oldestAgeDays ?? "-"
      }))
    );
    if (args.includes("--partitions")) console.table(report.partitions.map((p) => ({ partition: p.name, rows: p.rows, size: formatBytes(p.bytes) })));
    console.log(`database total: ${formatBytes(report.databaseBytes)} (includes indexes, TOAST, catalogs and WAL-independent overhead)`);
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
