import type { MigrationBuilder } from 'node-pg-migrate';

const DISCREPANCY_VALUES = "('short','over','damaged','substituted')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('purchase_order_receipt_lines', {
    expected_quantity: { type: 'numeric(18,6)' },
    discrepancy_reason: { type: 'text' },
    discrepancy_notes: { type: 'text' }
  });

  pgm.sql(
    `UPDATE purchase_order_receipt_lines
        SET expected_quantity = quantity_received
      WHERE expected_quantity IS NULL`
  );

  pgm.alterColumn('purchase_order_receipt_lines', 'expected_quantity', {
    notNull: true,
    default: 0
  });

  pgm.addConstraint(
    'purchase_order_receipt_lines',
    'chk_receipt_lines_discrepancy_reason',
    `CHECK (discrepancy_reason IS NULL OR discrepancy_reason IN ${DISCREPANCY_VALUES})`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('purchase_order_receipt_lines', 'chk_receipt_lines_discrepancy_reason', { ifExists: true });
  pgm.dropColumn('purchase_order_receipt_lines', 'discrepancy_notes');
  pgm.dropColumn('purchase_order_receipt_lines', 'discrepancy_reason');
  pgm.dropColumn('purchase_order_receipt_lines', 'expected_quantity');
}
