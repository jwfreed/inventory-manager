import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inventory_movement_lots', {
    id: { type: 'uuid', primaryKey: true },
    inventory_movement_line_id: {
      type: 'uuid',
      notNull: true,
      references: 'inventory_movement_lines',
      onDelete: 'CASCADE'
    },
    lot_id: { type: 'uuid', notNull: true, references: 'lots' },
    uom: { type: 'text', notNull: true },
    quantity_delta: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('inventory_movement_lots', 'chk_inventory_movement_lots_qty', {
    check: 'quantity_delta <> 0'
  });

  pgm.createIndex('inventory_movement_lots', 'lot_id', { name: 'idx_inventory_movement_lots_lot' });
  pgm.createIndex('inventory_movement_lots', 'inventory_movement_line_id', {
    name: 'idx_inventory_movement_lots_line'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('inventory_movement_lots');
}

