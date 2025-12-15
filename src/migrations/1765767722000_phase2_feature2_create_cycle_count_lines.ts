import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('cycle_count_lines', {
    id: { type: 'uuid', primaryKey: true },
    cycle_count_id: {
      type: 'uuid',
      notNull: true,
      references: 'cycle_counts',
      onDelete: 'CASCADE'
    },
    line_number: { type: 'integer', notNull: true },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    counted_quantity: { type: 'numeric(18,6)', notNull: true },
    system_quantity: { type: 'numeric(18,6)' },
    variance_quantity: { type: 'numeric(18,6)' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint(
    'cycle_count_lines',
    'chk_cycle_count_lines_counted_nonnegative',
    'CHECK (counted_quantity >= 0)'
  );
  pgm.addConstraint(
    'cycle_count_lines',
    'uq_cycle_count_lines_line_number',
    'UNIQUE (cycle_count_id, line_number)'
  );
  pgm.addConstraint(
    'cycle_count_lines',
    'uq_cycle_count_lines_item_uom',
    'UNIQUE (cycle_count_id, item_id, uom)'
  );
  pgm.createIndex('cycle_count_lines', 'item_id', { name: 'idx_cycle_count_lines_item_id' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('cycle_count_lines');
}
