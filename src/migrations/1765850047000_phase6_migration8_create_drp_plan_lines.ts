import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('drp_plan_lines', {
    id: { type: 'uuid', primaryKey: true },
    drp_run_id: { type: 'uuid', notNull: true, references: 'drp_runs', onDelete: 'CASCADE' },
    to_node_id: { type: 'uuid', notNull: true, references: 'drp_nodes' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    period_start: { type: 'date', notNull: true },
    begin_on_hand_qty: { type: 'numeric(18,6)' },
    gross_requirements_qty: { type: 'numeric(18,6)' },
    scheduled_receipts_qty: { type: 'numeric(18,6)' },
    net_requirements_qty: { type: 'numeric(18,6)' },
    planned_transfer_receipt_qty: { type: 'numeric(18,6)' },
    planned_transfer_release_qty: { type: 'numeric(18,6)' },
    projected_end_on_hand_qty: { type: 'numeric(18,6)' },
    computed_at: { type: 'timestamptz' }
  });

  pgm.addConstraint('drp_plan_lines', 'unique_drp_plan_lines_scope', {
    unique: ['drp_run_id', 'to_node_id', 'item_id', 'uom', 'period_start']
  });

  pgm.createIndex('drp_plan_lines', ['drp_run_id', 'period_start'], {
    name: 'idx_drp_plan_lines_run_period'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('drp_plan_lines');
}

