import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('items', {
    requires_lot: { type: 'boolean', notNull: true, default: false },
    requires_serial: { type: 'boolean', notNull: true, default: false },
    requires_qc: { type: 'boolean', notNull: true, default: false },
  });

  pgm.addColumn('purchase_order_lines', {
    over_receipt_tolerance_pct: { type: 'numeric(6,4)', notNull: true, default: 0 },
  });

  pgm.addColumn('purchase_order_receipts', {
    idempotency_key: { type: 'text' },
  });
  pgm.addConstraint('purchase_order_receipts', 'uq_po_receipts_idempotency', {
    unique: ['tenant_id', 'idempotency_key'],
  });

  pgm.addColumn('purchase_order_receipt_lines', {
    lot_code: { type: 'text' },
    serial_numbers: { type: 'text[]' },
    over_receipt_approved: { type: 'boolean', notNull: true, default: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('purchase_order_receipt_lines', ['lot_code', 'serial_numbers', 'over_receipt_approved'], {
    ifExists: true,
  });
  pgm.dropConstraint('purchase_order_receipts', 'uq_po_receipts_idempotency', { ifExists: true });
  pgm.dropColumn('purchase_order_receipts', 'idempotency_key', { ifExists: true });
  pgm.dropColumn('purchase_order_lines', 'over_receipt_tolerance_pct', { ifExists: true });
  pgm.dropColumns('items', ['requires_lot', 'requires_serial', 'requires_qc'], { ifExists: true });
}
