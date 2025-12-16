import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('sales_order_shipments', {
    id: { type: 'uuid', primaryKey: true },
    sales_order_id: { type: 'uuid', notNull: true, references: 'sales_orders' },
    shipped_at: { type: 'timestamptz', notNull: true },
    ship_from_location_id: { type: 'uuid', references: 'locations' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    external_ref: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('sales_order_shipments', ['sales_order_id', 'shipped_at'], {
    name: 'idx_shipments_order_shipped_at'
  });
  pgm.createIndex('sales_order_shipments', 'inventory_movement_id', { name: 'idx_shipments_movement' });

  pgm.createIndex('sales_order_shipments', 'inventory_movement_id', {
    name: 'idx_shipments_movement_unique',
    unique: true,
    where: 'inventory_movement_id IS NOT NULL'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('sales_order_shipments');
}

