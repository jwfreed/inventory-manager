import type { MigrationBuilder } from 'node-pg-migrate';

const CLOSEOUT_STATUS = "('open','closed','reopened')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inbound_closeouts', {
    id: { type: 'uuid', primaryKey: true },
    purchase_order_receipt_id: { type: 'uuid', notNull: true, references: 'purchase_order_receipts' },
    status: { type: 'text', notNull: true },
    closed_at: { type: 'timestamptz' },
    closed_by_actor_type: { type: 'text' },
    closed_by_actor_id: { type: 'text' },
    closeout_reason_code: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('inbound_closeouts', 'chk_inbound_closeouts_status', `CHECK (status IN ${CLOSEOUT_STATUS})`);
  pgm.addConstraint(
    'inbound_closeouts',
    'chk_inbound_closeouts_actor_type',
    "CHECK (closed_by_actor_type IS NULL OR closed_by_actor_type IN ('user','system'))"
  );
  pgm.createIndex('inbound_closeouts', 'status', { name: 'idx_inbound_closeouts_status' });
  pgm.createIndex('inbound_closeouts', 'purchase_order_receipt_id', { name: 'idx_inbound_closeouts_receipt' });
  pgm.createIndex('inbound_closeouts', 'closed_at', { name: 'idx_inbound_closeouts_closed_at' });
  pgm.addConstraint(
    'inbound_closeouts',
    'uq_inbound_closeouts_receipt',
    'UNIQUE (purchase_order_receipt_id)'
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('inbound_closeouts');
}
