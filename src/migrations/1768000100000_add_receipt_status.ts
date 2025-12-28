import type { MigrationBuilder } from 'node-pg-migrate';

const RECEIPT_STATUS_VALUES = "('posted','voided')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('purchase_order_receipts', {
    status: { type: 'text' }
  });
  pgm.sql("UPDATE purchase_order_receipts SET status = 'posted' WHERE status IS NULL");
  pgm.alterColumn('purchase_order_receipts', 'status', {
    notNull: true,
    default: 'posted'
  });
  pgm.addConstraint(
    'purchase_order_receipts',
    'chk_purchase_order_receipts_status',
    `CHECK (status IN ${RECEIPT_STATUS_VALUES})`
  );
  pgm.createIndex('purchase_order_receipts', 'status', { name: 'idx_po_receipts_status' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('purchase_order_receipts', 'idx_po_receipts_status', { ifExists: true });
  pgm.dropConstraint('purchase_order_receipts', 'chk_purchase_order_receipts_status', { ifExists: true });
  pgm.dropColumn('purchase_order_receipts', 'status');
}
