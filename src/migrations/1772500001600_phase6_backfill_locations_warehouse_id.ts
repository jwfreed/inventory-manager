import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Backfill locations.warehouse_id in tenant-scoped batches of 5,000.
  // Idempotent: only fills NULLs, and sets warehouse roots to self.
  await pgm.db.query(`
    DO $$
    DECLARE
      v_tenant uuid;
      v_batch integer;
    BEGIN
      UPDATE locations
         SET warehouse_id = id
       WHERE type = 'warehouse'
         AND (warehouse_id IS NULL OR warehouse_id <> id);

      FOR v_tenant IN
        SELECT DISTINCT tenant_id FROM locations
      LOOP
        LOOP
          WITH RECURSIVE target AS (
            SELECT id, parent_location_id, tenant_id
              FROM locations
             WHERE tenant_id = v_tenant
               AND type <> 'warehouse'
               AND warehouse_id IS NULL
             ORDER BY id
             LIMIT 5000
          ),
          walk AS (
            SELECT t.id AS target_id,
                   t.parent_location_id,
                   t.tenant_id,
                   0 AS depth
              FROM target t
            UNION ALL
            SELECT w.target_id,
                   l.parent_location_id,
                   w.tenant_id,
                   w.depth + 1 AS depth
              FROM walk w
              JOIN locations l
                ON l.id = w.parent_location_id
               AND l.tenant_id = w.tenant_id
             WHERE w.parent_location_id IS NOT NULL
               AND w.depth < 1000
          ),
          warehouses AS (
            SELECT w.target_id,
                   l.id AS warehouse_id,
                   w.depth
              FROM walk w
              JOIN locations l
                ON l.id = w.parent_location_id
               AND l.tenant_id = w.tenant_id
             WHERE l.type = 'warehouse'
          ),
          picked AS (
            SELECT DISTINCT ON (target_id) target_id, warehouse_id
              FROM warehouses
             ORDER BY target_id, depth ASC
          )
          UPDATE locations l
             SET warehouse_id = p.warehouse_id
            FROM picked p
           WHERE l.id = p.target_id
             AND l.warehouse_id IS NULL;

          GET DIAGNOSTICS v_batch = ROW_COUNT;
          EXIT WHEN v_batch = 0;
        END LOOP;
      END LOOP;
    END $$;
  `);

  /*
    Verification (optional):
    -- Warehouse roots should self-reference
    SELECT COUNT(*) FROM locations WHERE type = 'warehouse' AND warehouse_id <> id;

    -- Non-warehouses should have warehouse_id after backfill
    SELECT tenant_id, COUNT(*) AS nulls
      FROM locations
     WHERE type <> 'warehouse' AND warehouse_id IS NULL
     GROUP BY tenant_id
     ORDER BY nulls DESC;

    -- warehouse_id must point to a warehouse
    SELECT COUNT(*)
      FROM locations l
      JOIN locations w ON w.id = l.warehouse_id
     WHERE w.type <> 'warehouse';
  */
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  await pgm.db.query(`
    UPDATE locations SET warehouse_id = NULL;
  `);
}
