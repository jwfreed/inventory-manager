import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('return_receipt_lines', {
    id: { type: 'uuid', primaryKey: true },
    return_receipt_id: { type: 'uuid', notNull: true, references: 'return_receipts', onDelete: 'CASCADE' },
    return_authorization_line_id: { type: 'uuid', references: 'return_authorization_lines' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity_received: { type: 'numeric(18,6)', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('return_receipt_lines', 'chk_return_receipt_lines_qty', {
    check: 'quantity_received > 0'
  });

  pgm.createIndex('return_receipt_lines', 'return_receipt_id', { name: 'idx_return_receipt_lines_receipt' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('return_receipt_lines');
}

