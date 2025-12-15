import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('purchase_order_receipts', {
    id: { type: 'uuid', primaryKey: true },
    purchase_order_id: { type: 'uuid', notNull: true, references: 'purchase_orders' },
    received_at: { type: 'timestamptz', notNull: true },
    received_to_location_id: { type: 'uuid', references: 'locations' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    external_ref: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex(
    'purchase_order_receipts',
    ['purchase_order_id', 'received_at'],
    { name: 'idx_po_receipts_po_id_on_at' }
  );
  pgm.createIndex('purchase_order_receipts', 'inventory_movement_id', {
    name: 'idx_po_receipts_movement_id'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('purchase_order_receipts');
}
