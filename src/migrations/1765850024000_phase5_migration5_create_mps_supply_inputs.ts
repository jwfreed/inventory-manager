import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('mps_supply_inputs', {
    id: { type: 'uuid', primaryKey: true },
    mps_plan_item_id: { type: 'uuid', notNull: true, references: 'mps_plan_items', onDelete: 'CASCADE' },
    mps_period_id: { type: 'uuid', notNull: true, references: 'mps_periods', onDelete: 'CASCADE' },
    supply_type: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('mps_supply_inputs', 'unique_mps_supply_scope', {
    unique: ['mps_plan_item_id', 'mps_period_id', 'supply_type']
  });
  pgm.addConstraint('mps_supply_inputs', 'chk_mps_supply_type', {
    check: "supply_type IN ('work_orders')"
  });
  pgm.addConstraint('mps_supply_inputs', 'chk_mps_supply_quantity', {
    check: 'quantity >= 0'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('mps_supply_inputs');
}

