import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('return_disposition_lines', {
    id: { type: 'uuid', primaryKey: true },
    return_disposition_id: {
      type: 'uuid',
      notNull: true,
      references: 'return_dispositions',
      onDelete: 'CASCADE'
    },
    line_number: { type: 'integer', notNull: true },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('return_disposition_lines', 'unique_return_disposition_id_line_number', {
    unique: ['return_disposition_id', 'line_number']
  });

  pgm.addConstraint('return_disposition_lines', 'chk_return_disposition_lines_qty', {
    check: 'quantity > 0'
  });

  pgm.createIndex('return_disposition_lines', 'item_id', { name: 'idx_return_disposition_lines_item' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('return_disposition_lines');
}

