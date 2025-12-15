import type { MigrationBuilder } from 'node-pg-migrate';

const PO_STATUS_VALUES = "('draft','submitted','partially_received','received','closed','canceled')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('purchase_orders', {
    id: { type: 'uuid', primaryKey: true },
    po_number: { type: 'text', notNull: true, unique: true },
    vendor_id: { type: 'uuid', notNull: true, references: 'vendors' },
    status: { type: 'text', notNull: true },
    order_date: { type: 'date' },
    expected_date: { type: 'date' },
    ship_to_location_id: { type: 'uuid', references: 'locations' },
    vendor_reference: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.createIndex('purchase_orders', ['vendor_id', 'status'], {
    name: 'idx_po_vendor_status'
  });
  pgm.createIndex('purchase_orders', 'created_at', { name: 'idx_po_created_at' });
  pgm.addConstraint(
    'purchase_orders',
    'chk_purchase_orders_status',
    `CHECK (status IN ${PO_STATUS_VALUES})`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('purchase_orders');
}
