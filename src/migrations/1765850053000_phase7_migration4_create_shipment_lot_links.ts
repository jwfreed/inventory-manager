import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('shipment_lot_links', {
    id: { type: 'uuid', primaryKey: true },
    sales_order_shipment_id: {
      type: 'uuid',
      notNull: true,
      references: 'sales_order_shipments',
      onDelete: 'CASCADE'
    },
    inventory_movement_lot_id: {
      type: 'uuid',
      notNull: true,
      references: 'inventory_movement_lots',
      onDelete: 'CASCADE'
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('shipment_lot_links', 'sales_order_shipment_id', {
    name: 'idx_shipment_lot_links_shipment'
  });
  pgm.createIndex('shipment_lot_links', 'inventory_movement_lot_id', {
    name: 'idx_shipment_lot_links_lot'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('shipment_lot_links');
}

