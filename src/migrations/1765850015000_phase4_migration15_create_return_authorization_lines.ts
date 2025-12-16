import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('return_authorization_lines', {
    id: { type: 'uuid', primaryKey: true },
    return_authorization_id: {
      type: 'uuid',
      notNull: true,
      references: 'return_authorizations',
      onDelete: 'CASCADE'
    },
    line_number: { type: 'integer', notNull: true },
    sales_order_line_id: { type: 'uuid', references: 'sales_order_lines' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    quantity_authorized: { type: 'numeric(18,6)', notNull: true },
    reason_code: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('return_authorization_lines', 'unique_return_authorization_id_line_number', {
    unique: ['return_authorization_id', 'line_number']
  });

  pgm.addConstraint('return_authorization_lines', 'chk_rma_lines_qty', {
    check: 'quantity_authorized > 0'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('return_authorization_lines');
}

