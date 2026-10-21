// Database snapshots for the aged-database harness: per table rows, heap, index and TOAST bytes, dead tuples, autovacuum counters.
// Partitions are rolled up into their parent (audit_events). Run as the database owner.
export async function snapshot(client, { exactRows = true } = {}) {
  const sizes = await client.query(`
    WITH t AS (
      SELECT c.oid, coalesce(p.relname, c.relname) AS parent
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_inherits i ON i.inhrelid = c.oid LEFT JOIN pg_class p ON p.oid = i.inhparent
       WHERE n.nspname = 'public' AND c.relkind = 'r')
    SELECT t.parent AS name,
           sum(pg_total_relation_size(t.oid))::bigint AS total,
           sum(pg_relation_size(t.oid))::bigint AS heap,
           sum(pg_indexes_size(t.oid))::bigint AS idx,
           sum(pg_total_relation_size(t.oid) - pg_relation_size(t.oid) - pg_indexes_size(t.oid))::bigint AS toast,
           coalesce(sum(s.n_live_tup), 0)::bigint AS live, coalesce(sum(s.n_dead_tup), 0)::bigint AS dead,
           max(s.last_autovacuum) AS "lastAutovacuum", coalesce(sum(s.autovacuum_count), 0)::bigint AS "autovacuumCount",
           max(s.last_vacuum) AS "lastVacuum", coalesce(sum(s.n_tup_upd), 0)::bigint AS upd, coalesce(sum(s.n_tup_del), 0)::bigint AS del,
           coalesce(sum(s.n_tup_hot_upd), 0)::bigint AS "hotUpd"
      FROM t LEFT JOIN pg_stat_user_tables s ON s.relid = t.oid GROUP BY t.parent ORDER BY 2 DESC`);
  const tables = {};
  for (const r of sizes.rows) {
    let rows = Number(r.live);
    if (exactRows) rows = Number((await client.query(`SELECT count(*) AS c FROM "${r.name}"`)).rows[0].c);
    tables[r.name] = { rows, total: Number(r.total), heap: Number(r.heap), idx: Number(r.idx), toast: Number(r.toast), dead: Number(r.dead), autovacuumCount: Number(r.autovacuumCount), lastAutovacuum: r.lastAutovacuum, lastVacuum: r.lastVacuum, upd: Number(r.upd), del: Number(r.del), hotUpd: Number(r.hotUpd) };
  }
  const db = (await client.query("SELECT pg_database_size(current_database())::bigint AS bytes, pg_current_wal_lsn() AS lsn")).rows[0];
  return { at: new Date().toISOString(), dbBytes: Number(db.bytes), lsn: db.lsn, tables };
}

export const walBytes = async (client, fromLsn, toLsn) =>
  Number((await client.query("SELECT pg_wal_lsn_diff($1::pg_lsn, $2::pg_lsn)::bigint AS d", [toLsn, fromLsn])).rows[0].d);

export const mib = (b) => Math.round((b / 1048576) * 100) / 100;

export function printSnapshot(s) {
  const lines = ["table                      rows      total MiB  heap MiB  idx MiB  dead     autovac"];
  for (const [name, t] of Object.entries(s.tables))
    lines.push(`${name.padEnd(26)} ${String(t.rows).padStart(8)} ${String(mib(t.total)).padStart(10)} ${String(mib(t.heap)).padStart(9)} ${String(mib(t.idx)).padStart(8)} ${String(t.dead).padStart(8)} ${String(t.autovacuumCount).padStart(5)}`);
  lines.push(`database total ${mib(s.dbBytes)} MiB`);
  return lines.join("\n");
}
