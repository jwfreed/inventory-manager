import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS inventory_backorders (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants,
      status text NOT NULL,
      demand_type text NOT NULL,
      demand_id uuid NOT NULL,
      item_id uuid NOT NULL REFERENCES items,
      location_id uuid NOT NULL REFERENCES locations,
      uom text NOT NULL,
      quantity_backordered numeric(18,6) NOT NULL,
      backordered_at timestamptz NOT NULL DEFAULT now(),
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL,
      CONSTRAINT inventory_backorders_unique UNIQUE (
        tenant_id, demand_type, demand_id, item_id, location_id, uom
      ),
      CONSTRAINT chk_backorder_status CHECK (status IN ('open','fulfilled','canceled')),
      CONSTRAINT chk_backorder_demand_type CHECK (demand_type IN ('sales_order_line')),
      CONSTRAINT chk_backorder_quantity CHECK (quantity_backordered > 0)
    );
  `);

  pgm.sql(
    `CREATE INDEX IF NOT EXISTS idx_backorders_item_location
       ON inventory_backorders (tenant_id, item_id, location_id, uom);`
  );
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS idx_backorders_demand
       ON inventory_backorders (tenant_id, demand_type, demand_id);`
  );
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS idx_backorders_status
       ON inventory_backorders (tenant_id, status);`
  );
}

export async function down(_pgm: MigrationBuilder): Promise<void> {
  // Intentionally no-op: this migration only ensures the table exists.
}
