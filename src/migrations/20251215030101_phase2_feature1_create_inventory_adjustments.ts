import type { MigrationBuilder } from 'node-pg-migrate';

const ADJUSTMENT_STATUS = "('draft','posted','canceled')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inventory_adjustments', {
    id: { type: 'uuid', primaryKey: true },
    status: { type: 'text', notNull: true },
    occurred_at: { type: 'timestamptz', notNull: true },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('inventory_adjustments', 'chk_inventory_adjustments_status', `CHECK (status IN ${ADJUSTMENT_STATUS})`);
  pgm.addConstraint(
    'inventory_adjustments',
    'uq_inventory_adjustments_movement',
    'UNIQUE (inventory_movement_id)'
  );
  pgm.createIndex('inventory_adjustments', ['status', 'occurred_at'], {
    name: 'idx_inventory_adjustments_status_occurred'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('inventory_adjustments');
}
