import type { MigrationBuilder } from 'node-pg-migrate';

const CYCLE_COUNT_STATUS = "('draft','in_progress','posted','canceled')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('cycle_counts', {
    id: { type: 'uuid', primaryKey: true },
    status: { type: 'text', notNull: true },
    counted_at: { type: 'timestamptz', notNull: true },
    location_id: { type: 'uuid', notNull: true, references: 'locations' },
    notes: { type: 'text' },
    inventory_adjustment_id: { type: 'uuid', references: 'inventory_adjustments' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('cycle_counts', 'chk_cycle_counts_status', `CHECK (status IN ${CYCLE_COUNT_STATUS})`);
  pgm.createIndex('cycle_counts', 'inventory_adjustment_id', {
    name: 'idx_cycle_counts_adjustment',
    unique: true,
    where: 'inventory_adjustment_id IS NOT NULL'
  });
  pgm.createIndex('cycle_counts', 'inventory_movement_id', {
    name: 'idx_cycle_counts_movement',
    unique: true,
    where: 'inventory_movement_id IS NOT NULL'
  });
  pgm.createIndex('cycle_counts', ['location_id', 'counted_at'], { name: 'idx_cycle_counts_location_counted' });
  pgm.createIndex('cycle_counts', 'status', { name: 'idx_cycle_counts_status' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('cycle_counts');
}
