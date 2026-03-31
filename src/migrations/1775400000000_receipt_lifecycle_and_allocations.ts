import type { MigrationBuilder } from 'node-pg-migrate';

const RECEIPT_LIFECYCLE_VALUES = "('RECEIVED','VALIDATED','QC_PENDING','QC_COMPLETED','PUTAWAY_PENDING','AVAILABLE','REJECTED')";
const RECEIPT_ALLOCATION_STATUS_VALUES = "('QA','AVAILABLE','HOLD')";
const RECEIPT_EVENT_VALUES = "('VALIDATE','START_QC','COMPLETE_QC','START_PUTAWAY','COMPLETE_PUTAWAY','REJECT')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('purchase_order_receipts', {
    lifecycle_state: { type: 'text' }
  });

  pgm.sql(`
    WITH line_qc AS (
      SELECT
        prl.purchase_order_receipt_id AS receipt_id,
        COALESCE(SUM(CASE WHEN qe.event_type = 'accept' THEN qe.quantity ELSE 0 END), 0)::numeric AS accept_qty,
        COALESCE(SUM(CASE WHEN qe.event_type = 'hold' THEN qe.quantity ELSE 0 END), 0)::numeric AS hold_qty,
        COALESCE(SUM(CASE WHEN qe.event_type = 'reject' THEN qe.quantity ELSE 0 END), 0)::numeric AS reject_qty
      FROM purchase_order_receipt_lines prl
      LEFT JOIN qc_events qe
        ON qe.purchase_order_receipt_line_id = prl.id
       AND qe.tenant_id = prl.tenant_id
      GROUP BY prl.purchase_order_receipt_id
    ),
    line_putaway AS (
      SELECT
        prl.purchase_order_receipt_id AS receipt_id,
        COALESCE(SUM(CASE WHEN pl.status = 'completed' THEN COALESCE(pl.quantity_moved, 0) ELSE 0 END), 0)::numeric AS posted_qty
      FROM purchase_order_receipt_lines prl
      LEFT JOIN putaway_lines pl
        ON pl.purchase_order_receipt_line_id = prl.id
       AND pl.tenant_id = prl.tenant_id
       AND pl.status <> 'canceled'
      GROUP BY prl.purchase_order_receipt_id
    ),
    receipt_totals AS (
      SELECT
        por.id AS receipt_id,
        por.status,
        COALESCE(SUM(prl.quantity_received), 0)::numeric AS total_received,
        COALESCE(lq.accept_qty, 0)::numeric AS total_accept,
        COALESCE(lq.hold_qty, 0)::numeric AS total_hold,
        COALESCE(lq.reject_qty, 0)::numeric AS total_reject,
        COALESCE(lp.posted_qty, 0)::numeric AS posted_qty
      FROM purchase_order_receipts por
      LEFT JOIN purchase_order_receipt_lines prl
        ON prl.purchase_order_receipt_id = por.id
       AND prl.tenant_id = por.tenant_id
      LEFT JOIN line_qc lq
        ON lq.receipt_id = por.id
      LEFT JOIN line_putaway lp
        ON lp.receipt_id = por.id
      GROUP BY por.id, por.status, lq.accept_qty, lq.hold_qty, lq.reject_qty, lp.posted_qty
    )
    UPDATE purchase_order_receipts por
       SET lifecycle_state = CASE
         WHEN rt.status = 'voided' THEN 'REJECTED'
         WHEN rt.total_received <= 0 THEN 'RECEIVED'
         WHEN rt.total_received > (rt.total_accept + rt.total_hold + rt.total_reject) THEN 'QC_PENDING'
         WHEN rt.total_accept <= 0 THEN 'REJECTED'
         WHEN rt.posted_qty <= 0 THEN 'QC_COMPLETED'
         WHEN rt.posted_qty < rt.total_accept THEN 'PUTAWAY_PENDING'
         ELSE 'AVAILABLE'
       END
      FROM receipt_totals rt
     WHERE por.id = rt.receipt_id;
  `);

  pgm.alterColumn('purchase_order_receipts', 'lifecycle_state', {
    notNull: true,
    default: 'RECEIVED'
  });
  pgm.addConstraint(
    'purchase_order_receipts',
    'chk_purchase_order_receipts_lifecycle_state',
    `CHECK (lifecycle_state IN ${RECEIPT_LIFECYCLE_VALUES})`
  );
  pgm.createIndex('purchase_order_receipts', ['tenant_id', 'lifecycle_state'], {
    name: 'idx_purchase_order_receipts_tenant_lifecycle_state'
  });

  pgm.createTable('receipt_state_transitions', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    purchase_order_receipt_id: {
      type: 'uuid',
      notNull: true,
      references: 'purchase_order_receipts',
      onDelete: 'CASCADE'
    },
    event: { type: 'text', notNull: true },
    from_state: { type: 'text', notNull: true },
    to_state: { type: 'text', notNull: true },
    metadata: { type: 'jsonb' },
    occurred_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint(
    'receipt_state_transitions',
    'chk_receipt_state_transitions_event',
    `CHECK (event IN ${RECEIPT_EVENT_VALUES})`
  );
  pgm.addConstraint(
    'receipt_state_transitions',
    'chk_receipt_state_transitions_from_state',
    `CHECK (from_state IN ${RECEIPT_LIFECYCLE_VALUES})`
  );
  pgm.addConstraint(
    'receipt_state_transitions',
    'chk_receipt_state_transitions_to_state',
    `CHECK (to_state IN ${RECEIPT_LIFECYCLE_VALUES})`
  );
  pgm.createIndex('receipt_state_transitions', ['tenant_id', 'purchase_order_receipt_id', 'occurred_at'], {
    name: 'idx_receipt_state_transitions_receipt'
  });

  pgm.createTable('receipt_allocations', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    purchase_order_receipt_id: {
      type: 'uuid',
      notNull: true,
      references: 'purchase_order_receipts',
      onDelete: 'CASCADE'
    },
    purchase_order_receipt_line_id: {
      type: 'uuid',
      notNull: true,
      references: 'purchase_order_receipt_lines',
      onDelete: 'CASCADE'
    },
    warehouse_id: { type: 'uuid', notNull: true, references: 'locations' },
    location_id: { type: 'uuid', notNull: true, references: 'locations' },
    bin_id: { type: 'uuid', references: 'locations', onDelete: 'SET NULL' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements', onDelete: 'SET NULL' },
    inventory_movement_line_id: { type: 'uuid' },
    cost_layer_id: { type: 'uuid', references: 'inventory_cost_layers', onDelete: 'SET NULL' },
    quantity: { type: 'numeric(18,6)', notNull: true },
    status: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint(
    'receipt_allocations',
    'chk_receipt_allocations_status',
    `CHECK (status IN ${RECEIPT_ALLOCATION_STATUS_VALUES})`
  );
  pgm.addConstraint(
    'receipt_allocations',
    'chk_receipt_allocations_quantity_positive',
    'CHECK (quantity > 0)'
  );
  pgm.createIndex('receipt_allocations', ['tenant_id', 'purchase_order_receipt_line_id'], {
    name: 'idx_receipt_allocations_line'
  });
  pgm.createIndex('receipt_allocations', ['tenant_id', 'purchase_order_receipt_id', 'status'], {
    name: 'idx_receipt_allocations_receipt_status'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('receipt_allocations');
  pgm.dropTable('receipt_state_transitions');
  pgm.dropIndex('purchase_order_receipts', ['tenant_id', 'lifecycle_state'], {
    name: 'idx_purchase_order_receipts_tenant_lifecycle_state',
    ifExists: true
  });
  pgm.dropConstraint('purchase_order_receipts', 'chk_purchase_order_receipts_lifecycle_state', { ifExists: true });
  pgm.dropColumn('purchase_order_receipts', 'lifecycle_state');
}
