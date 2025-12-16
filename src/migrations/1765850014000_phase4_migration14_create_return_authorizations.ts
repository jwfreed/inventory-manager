import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('return_authorizations', {
    id: { type: 'uuid', primaryKey: true },
    rma_number: { type: 'text', notNull: true, unique: true },
    customer_id: { type: 'uuid', notNull: true, references: 'customers' },
    sales_order_id: { type: 'uuid', references: 'sales_orders' },
    status: { type: 'text', notNull: true },
    severity: { type: 'text' },
    authorized_at: { type: 'timestamptz' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('return_authorizations', 'chk_rma_status', {
    check: "status IN ('draft','authorized','closed','canceled')"
  });

  pgm.createIndex('return_authorizations', ['customer_id', 'status'], { name: 'idx_rmas_customer_status' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('return_authorizations');
}

