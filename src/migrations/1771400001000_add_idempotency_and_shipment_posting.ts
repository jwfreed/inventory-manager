import type { MigrationBuilder } from 'node-pg-migrate';

const SHIPMENT_STATUS = "('draft','posted','canceled')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('inventory_movements', {
    idempotency_key: { type: 'text' }
  });
  pgm.createIndex('inventory_movements', ['tenant_id', 'idempotency_key'], {
    name: 'uq_inventory_movements_idempotency',
    unique: true,
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('inventory_adjustments', {
    idempotency_key: { type: 'text' }
  });
  pgm.createIndex('inventory_adjustments', ['tenant_id', 'idempotency_key'], {
    name: 'uq_inventory_adjustments_idempotency',
    unique: true,
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('putaways', {
    idempotency_key: { type: 'text' }
  });
  pgm.createIndex('putaways', ['tenant_id', 'idempotency_key'], {
    name: 'uq_putaways_idempotency',
    unique: true,
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('cycle_counts', {
    idempotency_key: { type: 'text' }
  });
  pgm.createIndex('cycle_counts', ['tenant_id', 'idempotency_key'], {
    name: 'uq_cycle_counts_idempotency',
    unique: true,
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('inventory_reservations', {
    idempotency_key: { type: 'text' }
  });
  pgm.createIndex('inventory_reservations', ['tenant_id', 'idempotency_key'], {
    name: 'uq_inventory_reservations_idempotency',
    unique: true,
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('work_order_material_issues', {
    idempotency_key: { type: 'text' }
  });
  pgm.createIndex('work_order_material_issues', ['tenant_id', 'idempotency_key'], {
    name: 'uq_work_order_material_issues_idempotency',
    unique: true,
    where: 'idempotency_key IS NOT NULL'
  });

  pgm.addColumns('work_order_executions', {
    idempotency_key: { type: 'text' }
  });
  pgm.createIndex('work_order_executions', ['tenant_id', 'idempotency_key'], {
    name: 'uq_work_order_executions_idempotency',
    unique: true,
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
  pgm.createIndex('sales_order_shipments', ['tenant_id', 'posted_idempotency_key'], {
    name: 'uq_sales_order_shipments_posted_idempotency',
    unique: true,
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
  pgm.dropIndex('sales_order_shipments', ['tenant_id', 'posted_idempotency_key'], {
    name: 'uq_sales_order_shipments_posted_idempotency',
    ifExists: true
  });
  pgm.dropConstraint('sales_order_shipments', 'chk_sales_order_shipments_status', { ifExists: true });
  pgm.dropColumns('sales_order_shipments', ['status', 'posted_at', 'posted_idempotency_key']);

  pgm.dropIndex('work_order_executions', ['tenant_id', 'idempotency_key'], {
    name: 'uq_work_order_executions_idempotency',
    ifExists: true
  });
  pgm.dropColumns('work_order_executions', ['idempotency_key']);

  pgm.dropIndex('work_order_material_issues', ['tenant_id', 'idempotency_key'], {
    name: 'uq_work_order_material_issues_idempotency',
    ifExists: true
  });
  pgm.dropColumns('work_order_material_issues', ['idempotency_key']);

  pgm.dropIndex('inventory_reservations', ['tenant_id', 'idempotency_key'], {
    name: 'uq_inventory_reservations_idempotency',
    ifExists: true
  });
  pgm.dropColumns('inventory_reservations', ['idempotency_key']);

  pgm.dropIndex('cycle_counts', ['tenant_id', 'idempotency_key'], {
    name: 'uq_cycle_counts_idempotency',
    ifExists: true
  });
  pgm.dropColumns('cycle_counts', ['idempotency_key']);

  pgm.dropIndex('putaways', ['tenant_id', 'idempotency_key'], {
    name: 'uq_putaways_idempotency',
    ifExists: true
  });
  pgm.dropColumns('putaways', ['idempotency_key']);

  pgm.dropIndex('inventory_adjustments', ['tenant_id', 'idempotency_key'], {
    name: 'uq_inventory_adjustments_idempotency',
    ifExists: true
  });
  pgm.dropColumns('inventory_adjustments', ['idempotency_key']);

  pgm.dropIndex('inventory_movements', ['tenant_id', 'idempotency_key'], {
    name: 'uq_inventory_movements_idempotency',
    ifExists: true
  });
  pgm.dropColumns('inventory_movements', ['idempotency_key']);
}
