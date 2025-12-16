import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('pos_transaction_lines', {
    id: { type: 'uuid', primaryKey: true },
    pos_transaction_id: { type: 'uuid', notNull: true, references: 'pos_transactions', onDelete: 'CASCADE' },
    line_number: { type: 'integer', notNull: true },
    external_line_id: { type: 'text' },
    external_sku: { type: 'text' },
    item_id: { type: 'uuid', references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('pos_transaction_lines', 'pos_transaction_lines_line_unique', {
    unique: ['pos_transaction_id', 'line_number']
  });

  pgm.addConstraint('pos_transaction_lines', 'chk_pos_transaction_lines_qty', {
    check: 'quantity > 0'
  });

  pgm.createIndex('pos_transaction_lines', 'item_id', { name: 'idx_pos_transaction_lines_item' });
  pgm.createIndex('pos_transaction_lines', 'external_sku', { name: 'idx_pos_transaction_lines_external_sku' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('pos_transaction_lines');
}

