import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('packs', {
    id: { type: 'uuid', primaryKey: true },
    status: { type: 'text', notNull: true },
    sales_order_shipment_id: { type: 'uuid', notNull: true, references: 'sales_order_shipments' },
    package_ref: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('packs', 'chk_packs_status', {
    check: "status IN ('open','sealed','canceled')"
  });

  pgm.createIndex('packs', 'sales_order_shipment_id', { name: 'idx_packs_shipment' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('packs');
}

