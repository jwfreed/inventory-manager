import type { MigrationBuilder } from 'node-pg-migrate';

const MOVEMENT_STATUS_VALUES = "('draft','posted')";
const MOVEMENT_TYPE_VALUES = "('receive','issue','transfer','adjustment','count')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inventory_movements', {
    id: { type: 'uuid', primaryKey: true },
    movement_type: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    external_ref: { type: 'text' },
    occurred_at: { type: 'timestamptz', notNull: true },
    posted_at: { type: 'timestamptz' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.createIndex('inventory_movements', 'status', { name: 'idx_inventory_movements_status' });
  pgm.createIndex('inventory_movements', ['movement_type', 'occurred_at'], {
    name: 'idx_inventory_movements_type_occurred'
  });
  pgm.createIndex('inventory_movements', 'external_ref', { name: 'idx_inventory_movements_external_ref' });
  pgm.addConstraint(
    'inventory_movements',
    'chk_inventory_movements_status',
    `CHECK (status IN ${MOVEMENT_STATUS_VALUES})`
  );
  pgm.addConstraint(
    'inventory_movements',
    'chk_inventory_movements_type',
    `CHECK (movement_type IN ${MOVEMENT_TYPE_VALUES})`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('inventory_movements');
}
