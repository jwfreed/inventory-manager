import type { MigrationBuilder } from 'node-pg-migrate';

const PUTAWAY_STATUS = "('draft','in_progress','completed','canceled')";
const PUTAWAY_SOURCE_TYPES = "('purchase_order_receipt','qc','manual')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('putaways', {
    id: { type: 'uuid', primaryKey: true },
    status: { type: 'text', notNull: true },
    source_type: { type: 'text', notNull: true },
    purchase_order_receipt_id: { type: 'uuid', references: 'purchase_order_receipts' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('putaways', 'chk_putaways_status', `CHECK (status IN ${PUTAWAY_STATUS})`);
  pgm.addConstraint(
    'putaways',
    'chk_putaways_source_type',
    `CHECK (source_type IN ${PUTAWAY_SOURCE_TYPES})`
  );
  pgm.createIndex('putaways', 'status', { name: 'idx_putaways_status' });
  pgm.createIndex('putaways', 'purchase_order_receipt_id', { name: 'idx_putaways_receipt' });
  pgm.createIndex('putaways', 'inventory_movement_id', { name: 'idx_putaways_movement_id' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('putaways');
}
