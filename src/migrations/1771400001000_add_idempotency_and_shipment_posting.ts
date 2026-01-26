import type { MigrationBuilder } from 'node-pg-migrate';

const SHIPMENT_STATUS = "('draft','posted','canceled')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('inventory_movements', {
    idempotency_key: { type: 'text' }
  });
  pgm.addConstraint('inventory_movements', 'uq_inventory_movements_idempotency', {
    unique: ['tenant_id', 'idempotency_key'],
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('inventory_adjustments', {
    idempotency_key: { type: 'text' }
  });
  pgm.addConstraint('inventory_adjustments', 'uq_inventory_adjustments_idempotency', {
    unique: ['tenant_id', 'idempotency_key'],
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('putaways', {
    idempotency_key: { type: 'text' }
  });
  pgm.addConstraint('putaways', 'uq_putaways_idempotency', {
    unique: ['tenant_id', 'idempotency_key'],
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('cycle_counts', {
    idempotency_key: { type: 'text' }
  });
  pgm.addConstraint('cycle_counts', 'uq_cycle_counts_idempotency', {
    unique: ['tenant_id', 'idempotency_key'],
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('inventory_reservations', {
    idempotency_key: { type: 'text' }
  });
  pgm.addConstraint('inventory_reservations', 'uq_inventory_reservations_idempotency', {
    unique: ['tenant_id', 'idempotency_key'],
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('work_order_material_issues', {
    idempotency_key: { type: 'text' }
  });
  pgm.addConstraint('work_order_material_issues', 'uq_work_order_material_issues_idempotency', {
    unique: ['tenant_id', 'idempotency_key'],
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('work_order_executions', {
    idempotency_key: { type: 'text' }
  });
  pgm.addConstraint('work_order_executions', 'uq_work_order_executions_idempotency', {
    unique: ['tenant_id', 'idempotency_key'],
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('sales_order_shipments', {
    status: { type: 'text', notNull: true, default: 'draft' },
    posted_at: { type: 'timestamptz' },
    posted_idempotency_key: { type: 'text' }
  });
  pgm.addConstraint('sales_order_shipments', 'chk_sales_order_shipments_status', {
    check: `status IN ${SHIPMENT_STATUS}`
  });
  pgm.addConstraint('sales_order_shipments', 'uq_sales_order_shipments_posted_idempotency', {
    unique: ['tenant_id', 'posted_idempotency_key'],
    where: 'posted_idempotency_key IS NOT NULL'
  });

  pgm.sql(
    `UPDATE sales_order_shipments
        SET status = 'posted',
            posted_at = COALESCE(posted_at, shipped_at)
      WHERE inventory_movement_id IS NOT NULL`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('sales_order_shipments', 'uq_sales_order_shipments_posted_idempotency', { ifExists: true });
  pgm.dropConstraint('sales_order_shipments', 'chk_sales_order_shipments_status', { ifExists: true });
  pgm.dropColumns('sales_order_shipments', ['status', 'posted_at', 'posted_idempotency_key']);

  pgm.dropConstraint('work_order_executions', 'uq_work_order_executions_idempotency', { ifExists: true });
  pgm.dropColumns('work_order_executions', ['idempotency_key']);

  pgm.dropConstraint('work_order_material_issues', 'uq_work_order_material_issues_idempotency', { ifExists: true });
  pgm.dropColumns('work_order_material_issues', ['idempotency_key']);

  pgm.dropConstraint('inventory_reservations', 'uq_inventory_reservations_idempotency', { ifExists: true });
  pgm.dropColumns('inventory_reservations', ['idempotency_key']);

  pgm.dropConstraint('cycle_counts', 'uq_cycle_counts_idempotency', { ifExists: true });
  pgm.dropColumns('cycle_counts', ['idempotency_key']);

  pgm.dropConstraint('putaways', 'uq_putaways_idempotency', { ifExists: true });
  pgm.dropColumns('putaways', ['idempotency_key']);

  pgm.dropConstraint('inventory_adjustments', 'uq_inventory_adjustments_idempotency', { ifExists: true });
  pgm.dropColumns('inventory_adjustments', ['idempotency_key']);

  pgm.dropConstraint('inventory_movements', 'uq_inventory_movements_idempotency', { ifExists: true });
  pgm.dropColumns('inventory_movements', ['idempotency_key']);
}
