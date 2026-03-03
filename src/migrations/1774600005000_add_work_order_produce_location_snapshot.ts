import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Snapshot resolved produce-to location on production work orders.
 * This prevents report-production location drift when routing steps are edited later.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE work_orders
      ADD COLUMN IF NOT EXISTS produce_to_location_id_snapshot uuid;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_tenant_id_id_unique
      ON locations (tenant_id, id);
  `);

  pgm.sql(`
    ALTER TABLE work_orders
      DROP CONSTRAINT IF EXISTS fk_work_orders_produce_location_snapshot;
    ALTER TABLE work_orders
      ADD CONSTRAINT fk_work_orders_produce_location_snapshot
      FOREIGN KEY (tenant_id, produce_to_location_id_snapshot)
      REFERENCES locations(tenant_id, id)
      ON DELETE SET NULL;
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_work_orders_tenant_produce_location_snapshot
      ON work_orders (tenant_id, produce_to_location_id_snapshot);
  `);

  pgm.sql(`
    UPDATE work_orders wo
       SET produce_to_location_id_snapshot = selected.location_id
      FROM LATERAL (
        SELECT wc.location_id
          FROM routing_steps rs
          JOIN work_centers wc
            ON wc.id = rs.work_center_id
           AND wc.tenant_id = wo.tenant_id
         WHERE rs.tenant_id = wo.tenant_id
           AND rs.routing_id = wo.routing_id
           AND wc.location_id IS NOT NULL
         ORDER BY rs.sequence_number DESC
         LIMIT 1
      ) selected
     WHERE wo.kind = 'production'
       AND wo.status IN ('draft', 'released', 'in_progress')
       AND wo.routing_id IS NOT NULL
       AND wo.produce_to_location_id_snapshot IS NULL;
  `);

  pgm.sql(`
    COMMENT ON COLUMN work_orders.produce_to_location_id_snapshot IS
      'Produce-to location snapshot captured when work order is created/backfilled; report-production should prefer this over live routing step lookups.';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS fk_work_orders_produce_location_snapshot;
    DROP INDEX IF EXISTS idx_work_orders_tenant_produce_location_snapshot;
    DROP INDEX IF EXISTS idx_locations_tenant_id_id_unique;
    ALTER TABLE work_orders DROP COLUMN IF EXISTS produce_to_location_id_snapshot;
  `);
}
