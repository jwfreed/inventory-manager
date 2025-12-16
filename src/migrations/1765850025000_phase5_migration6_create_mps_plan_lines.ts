import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('mps_plan_lines', {
    id: { type: 'uuid', primaryKey: true },
    mps_plan_item_id: { type: 'uuid', notNull: true, references: 'mps_plan_items', onDelete: 'CASCADE' },
    mps_period_id: { type: 'uuid', notNull: true, references: 'mps_periods', onDelete: 'CASCADE' },
    begin_on_hand_qty: { type: 'numeric(18,6)' },
    demand_qty: { type: 'numeric(18,6)' },
    scheduled_receipts_qty: { type: 'numeric(18,6)' },
    net_requirements_qty: { type: 'numeric(18,6)' },
    planned_production_qty: { type: 'numeric(18,6)' },
    projected_end_on_hand_qty: { type: 'numeric(18,6)' },
    computed_at: { type: 'timestamptz' }
  });

  pgm.addConstraint('mps_plan_lines', 'unique_mps_plan_lines_scope', {
    unique: ['mps_plan_item_id', 'mps_period_id']
  });

  pgm.createIndex('mps_plan_lines', 'mps_period_id', { name: 'idx_mps_plan_lines_period' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('mps_plan_lines');
}

