import type { MigrationBuilder } from 'node-pg-migrate';

const PUTAWAY_LINE_STATUS = "('pending','completed','canceled')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('putaway_lines', {
    id: { type: 'uuid', primaryKey: true },
    putaway_id: {
      type: 'uuid',
      notNull: true,
      references: 'putaways',
      onDelete: 'CASCADE'
    },
    purchase_order_receipt_line_id: {
      type: 'uuid',
      notNull: true,
      references: 'purchase_order_receipt_lines'
    },
    line_number: { type: 'integer', notNull: true },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity_planned: { type: 'numeric(18,6)' },
    quantity_moved: { type: 'numeric(18,6)' },
    from_location_id: { type: 'uuid', notNull: true, references: 'locations' },
    to_location_id: { type: 'uuid', notNull: true, references: 'locations' },
    inventory_movement_id: { type: 'uuid', references: 'inventory_movements' },
    status: { type: 'text', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.addConstraint('putaway_lines', 'uq_putaway_lines_line_number', 'UNIQUE (putaway_id, line_number)');
  pgm.addConstraint(
    'putaway_lines',
    'chk_putaway_lines_status',
    `CHECK (status IN ${PUTAWAY_LINE_STATUS})`
  );
  pgm.addConstraint(
    'putaway_lines',
    'chk_putaway_lines_locations',
    'CHECK (from_location_id <> to_location_id)'
  );
  pgm.createIndex('putaway_lines', 'putaway_id', { name: 'idx_putaway_lines_putaway_id' });
  pgm.createIndex('putaway_lines', 'status', { name: 'idx_putaway_lines_status' });
  pgm.createIndex('putaway_lines', 'inventory_movement_id', { name: 'idx_putaway_lines_movement_id' });
  pgm.createIndex('putaway_lines', 'purchase_order_receipt_line_id', {
    name: 'idx_putaway_lines_receipt_line'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('putaway_lines');
}
