import type { MigrationBuilder } from 'node-pg-migrate';

const PO_LINE_STATUS_VALUES = "('open','complete','closed_short','cancelled')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('purchase_order_lines', {
    status: { type: 'text', notNull: true, default: 'open' },
    closed_reason: { type: 'text' },
    closed_notes: { type: 'text' },
    closed_at: { type: 'timestamptz' },
    closed_by_user_id: { type: 'uuid', references: 'users' }
  });

  pgm.addConstraint(
    'purchase_order_lines',
    'chk_purchase_order_lines_status',
    `CHECK (status IN ${PO_LINE_STATUS_VALUES})`
  );
  pgm.addConstraint(
    'purchase_order_lines',
    'chk_purchase_order_lines_closed_reason_required',
    `CHECK (
      (status IN ('closed_short', 'cancelled') AND closed_reason IS NOT NULL AND closed_at IS NOT NULL)
      OR
      (status NOT IN ('closed_short', 'cancelled'))
    )`
  );
  pgm.createIndex('purchase_order_lines', ['tenant_id', 'status'], {
    name: 'idx_purchase_order_lines_tenant_status'
  });

  pgm.addColumn('purchase_orders', {
    close_reason: { type: 'text' },
    close_notes: { type: 'text' },
    closed_at: { type: 'timestamptz' },
    closed_by_user_id: { type: 'uuid', references: 'users' }
  });

  pgm.sql(`
    WITH received AS (
      SELECT porl.purchase_order_line_id AS line_id,
             COALESCE(SUM(porl.quantity_received), 0)::numeric AS qty_received
        FROM purchase_order_receipt_lines porl
        JOIN purchase_order_receipts por
          ON por.id = porl.purchase_order_receipt_id
         AND por.tenant_id = porl.tenant_id
       WHERE COALESCE(por.status, 'posted') <> 'voided'
       GROUP BY porl.purchase_order_line_id
    )
    UPDATE purchase_order_lines pol
       SET status = CASE
         WHEN po.status = 'canceled' THEN 'cancelled'
         WHEN COALESCE((
           SELECT r.qty_received
             FROM received r
            WHERE r.line_id = pol.id
         ), 0) >= pol.quantity_ordered - 0.000001 THEN 'complete'
         ELSE 'open'
       END,
       closed_reason = CASE
         WHEN po.status = 'canceled' THEN COALESCE(pol.closed_reason, 'migration_backfill_po_canceled')
         ELSE pol.closed_reason
       END,
       closed_at = CASE
         WHEN po.status = 'canceled' THEN COALESCE(pol.closed_at, po.updated_at, po.created_at, now())
         ELSE pol.closed_at
       END
      FROM purchase_orders po
     WHERE po.id = pol.purchase_order_id
       AND po.tenant_id = pol.tenant_id;
  `);

  pgm.sql(`
    UPDATE purchase_orders
       SET close_reason = COALESCE(close_reason, 'migration_backfill_po_closed'),
           closed_at = COALESCE(closed_at, updated_at, created_at, now())
     WHERE status IN ('closed', 'canceled')
       AND closed_at IS NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns(
    'purchase_orders',
    ['close_reason', 'close_notes', 'closed_at', 'closed_by_user_id'],
    { ifExists: true }
  );

  pgm.dropIndex('purchase_order_lines', ['tenant_id', 'status'], {
    ifExists: true,
    name: 'idx_purchase_order_lines_tenant_status'
  });
  pgm.dropConstraint('purchase_order_lines', 'chk_purchase_order_lines_closed_reason_required', {
    ifExists: true
  });
  pgm.dropConstraint('purchase_order_lines', 'chk_purchase_order_lines_status', { ifExists: true });
  pgm.dropColumns(
    'purchase_order_lines',
    ['status', 'closed_reason', 'closed_notes', 'closed_at', 'closed_by_user_id'],
    { ifExists: true }
  );
}
