import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createSequence('receipt_number_seq', { ifNotExists: true });
  pgm.createSequence('putaway_number_seq', { ifNotExists: true });

  pgm.addColumn('purchase_order_receipts', {
    receipt_number: { type: 'text' }
  });
  pgm.addConstraint('purchase_order_receipts', 'uq_receipt_number', {
    unique: ['tenant_id', 'receipt_number']
  });

  pgm.addColumn('putaways', {
    putaway_number: { type: 'text' },
    completed_at: { type: 'timestamptz' },
    completed_by_user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' }
  });
  pgm.addConstraint('putaways', 'uq_putaway_number', {
    unique: ['tenant_id', 'putaway_number']
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('putaways', 'uq_putaway_number', { ifExists: true });
  pgm.dropColumns('putaways', ['putaway_number', 'completed_at', 'completed_by_user_id'], { ifExists: true });

  pgm.dropConstraint('purchase_order_receipts', 'uq_receipt_number', { ifExists: true });
  pgm.dropColumn('purchase_order_receipts', 'receipt_number', { ifExists: true });

  pgm.dropSequence('putaway_number_seq', { ifExists: true });
  pgm.dropSequence('receipt_number_seq', { ifExists: true });
}
