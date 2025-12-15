import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inventory_movement_lines', {
    id: { type: 'uuid', primaryKey: true },
    movement_id: {
      type: 'uuid',
      notNull: true,
      references: 'inventory_movements',
      onDelete: 'CASCADE'
    },
    item_id: {
      type: 'uuid',
      notNull: true,
      references: 'items'
    },
    location_id: {
      type: 'uuid',
      notNull: true,
      references: 'locations'
    },
    quantity_delta: { type: 'numeric(18,6)', notNull: true },
    uom: { type: 'text', notNull: true },
    reason_code: { type: 'text' },
    line_notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('inventory_movement_lines', 'movement_id', {
    name: 'idx_movement_lines_movement_id'
  });
  pgm.createIndex('inventory_movement_lines', ['item_id', 'location_id'], {
    name: 'idx_movement_lines_item_location'
  });
  pgm.createIndex('inventory_movement_lines', ['location_id', 'item_id'], {
    name: 'idx_movement_lines_location_item'
  });
  pgm.addConstraint(
    'inventory_movement_lines',
    'chk_movement_lines_qty_nonzero',
    'CHECK (quantity_delta <> 0)'
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('inventory_movement_lines');
}
