import type { Db } from './database.ts';

/** Tables the purge leaves alone: the audit log is append-only, and the tenant row goes in its own step. */
const KEPT = new Set(['events', 'tenants']);
/** Undeletable while their tenant exists (see migration 7), so they go after the tenant row. */
const AFTER_TENANT = ['workflow_versions', 'plans'];
/** Hold references to other tenant tables, so they are emptied last. */
const LAST = ['sessions', 'api_keys', 'users'];

/**
 * Erase everything a tenant owns except its events: the audit chain keeps its record that the tenant existed and what
 * happened, and `verify-audit` still passes. Tables are found from the schema, so a table added later is covered.
 */
export function purgeTenant(db: Db, id: string): void {
  const owned = db
    .all<{ name: string }>(
      `SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) p
       WHERE m.type = 'table' AND p.name = 'tenant_id'`,
    )
    .map((r) => r.name)
    .filter((t) => !KEPT.has(t));
  const middle = owned.filter((t) => !AFTER_TENANT.includes(t) && !LAST.includes(t));
  db.transaction(() => {
    // tables that reach the tenant through a parent row instead of carrying `tenant_id`
    db.run('DELETE FROM step_states WHERE run_id IN (SELECT id FROM runs WHERE tenant_id = ?)', [id]);
    db.run('DELETE FROM trigger_fires WHERE trigger_id IN (SELECT id FROM triggers WHERE tenant_id = ?)', [id]);
    for (const table of [...middle, ...LAST]) db.run(`DELETE FROM ${table} WHERE tenant_id = ?`, [id]);
    db.run('DELETE FROM tenants WHERE id = ?', [id]);
    for (const table of AFTER_TENANT) db.run(`DELETE FROM ${table} WHERE tenant_id = ?`, [id]);
  });
}
