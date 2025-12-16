import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('sales_orders', {
    id: { type: 'uuid', primaryKey: true },
    so_number: { type: 'text', notNull: true, unique: true },
    customer_id: { type: 'uuid', notNull: true, references: 'customers' },
    status: { type: 'text', notNull: true },
    order_date: { type: 'date' },
    requested_ship_date: { type: 'date' },
    ship_from_location_id: { type: 'uuid', references: 'locations' },
    customer_reference: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('sales_orders', 'chk_sales_orders_status', {
    check: "status IN ('draft','submitted','partially_shipped','shipped','closed','canceled')"
  });

  pgm.createIndex('sales_orders', ['customer_id', 'status'], { name: 'idx_sales_orders_customer_status' });
  pgm.createIndex('sales_orders', 'created_at', { name: 'idx_sales_orders_created_at' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('sales_orders');
}

