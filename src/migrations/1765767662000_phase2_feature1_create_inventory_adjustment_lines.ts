import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('inventory_adjustment_lines', {
    id: { type: 'uuid', primaryKey: true },
    inventory_adjustment_id: {
      type: 'uuid',
      notNull: true,
      references: 'inventory_adjustments',
      onDelete: 'CASCADE'
    },
    line_number: { type: 'integer', notNull: true },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    location_id: { type: 'uuid', notNull: true, references: 'locations' },
    uom: { type: 'text', notNull: true },
    quantity_delta: { type: 'numeric(18,6)', notNull: true },
    reason_code: { type: 'text', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint(
    'inventory_adjustment_lines',
    'chk_inventory_adjustment_lines_qty_nonzero',
    'CHECK (quantity_delta <> 0)'
  );
  pgm.addConstraint(
    'inventory_adjustment_lines',
    'uq_inventory_adjustment_lines_line_number',
    'UNIQUE (inventory_adjustment_id, line_number)'
  );
  pgm.createIndex('inventory_adjustment_lines', ['item_id', 'location_id', 'uom'], {
    name: 'idx_inventory_adjustment_lines_item_location_uom'
  });
  pgm.createIndex('inventory_adjustment_lines', 'reason_code', {
    name: 'idx_inventory_adjustment_lines_reason'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('inventory_adjustment_lines');
}
