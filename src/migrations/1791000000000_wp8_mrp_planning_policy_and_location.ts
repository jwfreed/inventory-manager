import type { MigrationBuilder } from 'node-pg-migrate';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('mrp_runs', {
    demand_mode: { type: 'text', notNull: true, default: 'mps_only' },
  });
  pgm.addConstraint('mrp_runs', 'chk_mrp_runs_demand_mode', {
    check: "demand_mode IN ('mps_only','sales_orders_only','combined')",
  });

  pgm.addColumns('mrp_planned_orders', {
    status: { type: 'text', notNull: true, default: 'planned' },
  });
  pgm.addConstraint('mrp_planned_orders', 'chk_mrp_planned_orders_status', {
    check: "status IN ('planned','firmed','released')",
  });
  pgm.createIndex('mrp_planned_orders', ['mrp_run_id', 'status'], {
    name: 'idx_mrp_planned_orders_run_status',
  });

  pgm.sql(`
    CREATE UNIQUE INDEX uq_mrp_item_policies_scope_normalized
      ON mrp_item_policies (
        mrp_run_id,
        item_id,
        uom,
        COALESCE(site_location_id, '${NIL_UUID}'::uuid)
      );
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX uq_mrp_plan_lines_scope_period_normalized
      ON mrp_plan_lines (
        mrp_run_id,
        item_id,
        uom,
        COALESCE(site_location_id, '${NIL_UUID}'::uuid),
        period_start
      );
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX uq_mrp_planned_orders_scope_period_normalized
      ON mrp_planned_orders (
        mrp_run_id,
        item_id,
        uom,
        COALESCE(site_location_id, '${NIL_UUID}'::uuid),
        receipt_date
      );
  `);

  pgm.createIndex('mrp_gross_requirements', ['mrp_run_id', 'source_ref'], {
    name: 'uq_mrp_gross_requirements_sales_order_source_ref',
    unique: true,
    where: "source_type = 'sales_orders' AND source_ref IS NOT NULL",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('mrp_gross_requirements', ['mrp_run_id', 'source_ref'], {
    name: 'uq_mrp_gross_requirements_sales_order_source_ref',
    ifExists: true,
  });

  pgm.sql('DROP INDEX IF EXISTS uq_mrp_planned_orders_scope_period_normalized;');
  pgm.sql('DROP INDEX IF EXISTS uq_mrp_plan_lines_scope_period_normalized;');
  pgm.sql('DROP INDEX IF EXISTS uq_mrp_item_policies_scope_normalized;');

  pgm.dropIndex('mrp_planned_orders', ['mrp_run_id', 'status'], {
    name: 'idx_mrp_planned_orders_run_status',
    ifExists: true,
  });
  pgm.dropConstraint('mrp_planned_orders', 'chk_mrp_planned_orders_status', { ifExists: true });
  pgm.dropColumns('mrp_planned_orders', ['status'], { ifExists: true });

  pgm.dropConstraint('mrp_runs', 'chk_mrp_runs_demand_mode', { ifExists: true });
  pgm.dropColumns('mrp_runs', ['demand_mode'], { ifExists: true });
}
