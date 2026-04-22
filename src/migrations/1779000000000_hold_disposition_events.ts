import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('hold_disposition_events', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    purchase_order_receipt_line_id: {
      type: 'uuid',
      notNull: true,
      references: 'purchase_order_receipt_lines',
      onDelete: 'CASCADE'
    },
    inventory_movement_id: {
      type: 'uuid',
      references: 'inventory_movements',
      onDelete: 'SET NULL'
    },
    disposition_type: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    uom: { type: 'text', notNull: true },
    reason_code: { type: 'text' },
    notes: { type: 'text' },
    actor_type: { type: 'text' },
    actor_id: { type: 'uuid' },
    occurred_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint(
    'hold_disposition_events',
    'chk_hold_disposition_type',
    "CHECK (disposition_type IN ('release', 'rework', 'discard'))"
  );
  pgm.addConstraint(
    'hold_disposition_events',
    'chk_hold_disposition_quantity_positive',
    'CHECK (quantity > 0)'
  );
  pgm.createIndex('hold_disposition_events', ['tenant_id', 'purchase_order_receipt_line_id'], {
    name: 'idx_hold_disposition_events_line'
  });

  // Expand receipt_allocations status to include terminal disposition statuses.
  // REWORK and DISCARDED are terminal: quantity remains tracked for conservation
  // but is excluded from available/active buckets.
  pgm.dropConstraint('receipt_allocations', 'chk_receipt_allocations_status');
  pgm.addConstraint(
    'receipt_allocations',
    'chk_receipt_allocations_status',
    "CHECK (status IN ('QA','AVAILABLE','HOLD','REWORK','DISCARDED'))"
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('hold_disposition_events');
  pgm.dropConstraint('receipt_allocations', 'chk_receipt_allocations_status');
  pgm.addConstraint(
    'receipt_allocations',
    'chk_receipt_allocations_status',
    "CHECK (status IN ('QA','AVAILABLE','HOLD'))"
  );
}
