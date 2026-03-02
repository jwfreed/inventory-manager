import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS work_order_lot_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      work_order_execution_id uuid NOT NULL REFERENCES work_order_executions(id) ON DELETE CASCADE,
      role text NOT NULL,
      item_id uuid NOT NULL REFERENCES items(id),
      lot_id uuid NOT NULL REFERENCES lots(id),
      uom text NOT NULL,
      quantity numeric(18,6) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_work_order_lot_links_role CHECK (role IN ('consume', 'produce')),
      CONSTRAINT chk_work_order_lot_links_quantity CHECK (quantity > 0)
    );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_work_order_lot_links_tenant
      ON work_order_lot_links (tenant_id);
    CREATE INDEX IF NOT EXISTS idx_work_order_lot_links_execution
      ON work_order_lot_links (tenant_id, work_order_execution_id);
    CREATE INDEX IF NOT EXISTS idx_work_order_lot_links_lot
      ON work_order_lot_links (tenant_id, lot_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_order_lot_links_dedupe
      ON work_order_lot_links (tenant_id, work_order_execution_id, role, item_id, lot_id, uom);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TABLE IF EXISTS work_order_lot_links');
}
