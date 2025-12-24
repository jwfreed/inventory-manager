import type { MigrationBuilder } from 'node-pg-migrate';

const PO_STATUS_VALUES = "('draft','submitted','approved','partially_received','received','closed','canceled')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('purchase_orders', 'chk_purchase_orders_status');
  pgm.addConstraint(
    'purchase_orders',
    'chk_purchase_orders_status',
    `CHECK (status IN ${PO_STATUS_VALUES})`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('purchase_orders', 'chk_purchase_orders_status');
  pgm.addConstraint(
    'purchase_orders',
    'chk_purchase_orders_status',
    "CHECK (status IN ('draft','submitted','partially_received','received','closed','canceled'))"
  );
}
