import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('purchase_order_lines', {
    id: { type: 'uuid', primaryKey: true },
    purchase_order_id: {
      type: 'uuid',
      notNull: true,
      references: 'purchase_orders',
      onDelete: 'CASCADE'
    },
    line_number: { type: 'integer', notNull: true },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity_ordered: { type: 'numeric(18,6)', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint(
    'purchase_order_lines',
    'uq_po_lines_po_id_line_number',
    'UNIQUE (purchase_order_id, line_number)'
  );
  pgm.addConstraint(
    'purchase_order_lines',
    'chk_po_lines_qty_positive',
    'CHECK (quantity_ordered > 0)'
  );
  pgm.createIndex('purchase_order_lines', 'purchase_order_id', {
    name: 'idx_po_lines_po_id'
  });
  pgm.createIndex('purchase_order_lines', 'item_id', {
    name: 'idx_po_lines_item_id'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('purchase_order_lines');
}
