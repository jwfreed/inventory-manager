import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Snapshot routing on work orders so report-production does not drift when item default routing changes later.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE work_orders
      ADD COLUMN IF NOT EXISTS routing_id uuid;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_work_orders_routing_tenant'
           AND conrelid = 'work_orders'::regclass
      ) THEN
        ALTER TABLE work_orders
          ADD CONSTRAINT fk_work_orders_routing_tenant
          FOREIGN KEY (tenant_id, routing_id)
          REFERENCES routings(tenant_id, id)
          ON DELETE RESTRICT;
      END IF;
    END $$;
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_work_orders_tenant_routing_id
      ON work_orders (tenant_id, routing_id);
  `);

  pgm.sql(`
    UPDATE work_orders wo
       SET routing_id = (
        SELECT r.id
          FROM routings r
         WHERE r.tenant_id = wo.tenant_id
           AND r.item_id = wo.output_item_id
         ORDER BY
           CASE WHEN r.is_default THEN 0 ELSE 1 END,
           CASE
             WHEN r.status = 'active' THEN 0
             WHEN r.status = 'draft' THEN 1
             ELSE 2
           END,
           r.updated_at DESC,
           r.created_at DESC,
           r.id
         LIMIT 1
      )
     WHERE wo.routing_id IS NULL
       AND wo.kind = 'production'
       AND wo.status IN ('draft', 'released', 'in_progress');
  `);

  pgm.sql(`
    COMMENT ON COLUMN work_orders.routing_id IS
      'Routing snapshot captured when work order is created/backfilled; report-production should prefer this over current item default routing.';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS fk_work_orders_routing_tenant;
    DROP INDEX IF EXISTS idx_work_orders_tenant_routing_id;
    ALTER TABLE work_orders DROP COLUMN IF EXISTS routing_id;
  `);
}
