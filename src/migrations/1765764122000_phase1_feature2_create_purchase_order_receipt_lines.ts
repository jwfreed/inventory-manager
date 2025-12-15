import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('purchase_order_receipt_lines', {
    id: { type: 'uuid', primaryKey: true },
    purchase_order_receipt_id: {
      type: 'uuid',
      notNull: true,
      references: 'purchase_order_receipts',
      onDelete: 'CASCADE'
    },
    purchase_order_line_id: { type: 'uuid', notNull: true, references: 'purchase_order_lines' },
    uom: { type: 'text', notNull: true },
    quantity_received: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint(
    'purchase_order_receipt_lines',
    'chk_po_receipt_lines_qty_positive',
    'CHECK (quantity_received > 0)'
  );
  pgm.createIndex('purchase_order_receipt_lines', 'purchase_order_receipt_id', {
    name: 'idx_po_receipt_lines_receipt_id'
  });
  pgm.createIndex('purchase_order_receipt_lines', 'purchase_order_line_id', {
    name: 'idx_po_receipt_lines_line_id'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('purchase_order_receipt_lines');
}
