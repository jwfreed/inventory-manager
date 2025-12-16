import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('sales_order_shipment_lines', {
    id: { type: 'uuid', primaryKey: true },
    sales_order_shipment_id: {
      type: 'uuid',
      notNull: true,
      references: 'sales_order_shipments',
      onDelete: 'CASCADE'
    },
    sales_order_line_id: { type: 'uuid', notNull: true, references: 'sales_order_lines' },
    uom: { type: 'text', notNull: true },
    quantity_shipped: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('sales_order_shipment_lines', 'chk_shipment_lines_qty_positive', {
    check: 'quantity_shipped > 0'
  });

  pgm.createIndex('sales_order_shipment_lines', 'sales_order_shipment_id', { name: 'idx_shipment_lines_shipment' });
  pgm.createIndex('sales_order_shipment_lines', 'sales_order_line_id', { name: 'idx_shipment_lines_line' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('sales_order_shipment_lines');
}

