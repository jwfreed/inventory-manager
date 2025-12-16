import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('mps_demand_inputs', {
    id: { type: 'uuid', primaryKey: true },
    mps_plan_item_id: { type: 'uuid', notNull: true, references: 'mps_plan_items', onDelete: 'CASCADE' },
    mps_period_id: { type: 'uuid', notNull: true, references: 'mps_periods', onDelete: 'CASCADE' },
    demand_type: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('mps_demand_inputs', 'unique_mps_demand_scope', {
    unique: ['mps_plan_item_id', 'mps_period_id', 'demand_type']
  });
  pgm.addConstraint('mps_demand_inputs', 'chk_mps_demand_type', {
    check: "demand_type IN ('forecast','sales_orders')"
  });
  pgm.addConstraint('mps_demand_inputs', 'chk_mps_demand_quantity', {
    check: 'quantity >= 0'
  });

  pgm.createIndex('mps_demand_inputs', 'mps_period_id', { name: 'idx_mps_demand_inputs_period' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('mps_demand_inputs');
}

