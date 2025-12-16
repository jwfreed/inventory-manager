import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('sales_order_lines', {
    id: { type: 'uuid', primaryKey: true },
    sales_order_id: { type: 'uuid', notNull: true, references: 'sales_orders', onDelete: 'CASCADE' },
    line_number: { type: 'integer', notNull: true },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity_ordered: { type: 'numeric(18,6)', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('sales_order_lines', 'sales_order_lines_line_unique', {
    unique: ['sales_order_id', 'line_number']
  });

  pgm.addConstraint('sales_order_lines', 'chk_so_lines_qty_positive', {
    check: 'quantity_ordered > 0'
  });

  pgm.createIndex('sales_order_lines', 'sales_order_id', { name: 'idx_so_lines_order' });
  pgm.createIndex('sales_order_lines', 'item_id', { name: 'idx_so_lines_item' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('sales_order_lines');
}

