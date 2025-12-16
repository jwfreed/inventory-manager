import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('mrp_plan_lines', {
    id: { type: 'uuid', primaryKey: true },
    mrp_run_id: { type: 'uuid', notNull: true, references: 'mrp_runs', onDelete: 'CASCADE' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    site_location_id: { type: 'uuid', references: 'locations' },
    period_start: { type: 'date', notNull: true },
    begin_on_hand_qty: { type: 'numeric(18,6)' },
    gross_requirements_qty: { type: 'numeric(18,6)' },
    scheduled_receipts_qty: { type: 'numeric(18,6)' },
    net_requirements_qty: { type: 'numeric(18,6)' },
    planned_order_receipt_qty: { type: 'numeric(18,6)' },
    planned_order_release_qty: { type: 'numeric(18,6)' },
    projected_end_on_hand_qty: { type: 'numeric(18,6)' },
    computed_at: { type: 'timestamptz' }
  });

  pgm.addConstraint('mrp_plan_lines', 'unique_mrp_plan_lines_scope', {
    unique: ['mrp_run_id', 'item_id', 'uom', 'site_location_id', 'period_start']
  });

  pgm.createIndex('mrp_plan_lines', ['mrp_run_id', 'period_start'], {
    name: 'idx_mrp_plan_lines_run_period'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('mrp_plan_lines');
}

