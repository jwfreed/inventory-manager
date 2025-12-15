import type { MigrationBuilder } from 'node-pg-migrate';

const QC_EVENT_TYPES = "('hold','accept','reject')";
const QC_ACTOR_TYPES = "('user','system')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('qc_events', {
    id: { type: 'uuid', primaryKey: true },
    purchase_order_receipt_line_id: {
      type: 'uuid',
      notNull: true,
      references: 'purchase_order_receipt_lines',
      onDelete: 'CASCADE'
    },
    event_type: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    uom: { type: 'text', notNull: true },
    reason_code: { type: 'text' },
    notes: { type: 'text' },
    actor_type: { type: 'text', notNull: true },
    actor_id: { type: 'text' },
    occurred_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('qc_events', 'chk_qc_event_type', `CHECK (event_type IN ${QC_EVENT_TYPES})`);
  pgm.addConstraint('qc_events', 'chk_qc_event_quantity', 'CHECK (quantity > 0)');
  pgm.addConstraint('qc_events', 'chk_qc_actor_type', `CHECK (actor_type IN ${QC_ACTOR_TYPES})`);
  pgm.createIndex('qc_events', ['purchase_order_receipt_line_id', 'occurred_at'], {
    name: 'idx_qc_events_receipt_line'
  });
  pgm.createIndex('qc_events', ['event_type', 'occurred_at'], {
    name: 'idx_qc_events_event_type'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('qc_events');
}
