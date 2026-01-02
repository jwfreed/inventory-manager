import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('vendor_invoice_lines', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    vendor_invoice_id: { type: 'uuid', notNull: true, references: 'vendor_invoices', onDelete: 'CASCADE' },
    line_number: { type: 'integer', notNull: true },
    purchase_order_line_id: { type: 'uuid', notNull: false, references: 'purchase_order_lines' },
    receipt_line_id: { type: 'uuid', notNull: false, references: 'purchase_order_receipt_lines' },
    item_id: { type: 'uuid', notNull: false, references: 'items' },
    description: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    uom: { type: 'text', notNull: true },
    unit_price: { type: 'numeric(18,6)', notNull: true },
    line_amount: { type: 'numeric(18,6)', notNull: true },
    tax_amount: { type: 'numeric(18,6)', notNull: true, default: 0 },
    gl_account_id: { type: 'uuid', notNull: false },
    notes: { type: 'text', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('vendor_invoice_lines', 'uq_vendor_invoice_lines_number', {
    unique: ['vendor_invoice_id', 'line_number']
  });

  pgm.addConstraint('vendor_invoice_lines', 'chk_vendor_invoice_lines_amount', {
    check: 'line_amount = quantity * unit_price'
  });

  pgm.createIndex('vendor_invoice_lines', ['tenant_id', 'vendor_invoice_id']);
  pgm.createIndex('vendor_invoice_lines', ['tenant_id', 'item_id']);
  pgm.createIndex('vendor_invoice_lines', ['tenant_id', 'purchase_order_line_id']);
  pgm.createIndex('vendor_invoice_lines', ['tenant_id', 'receipt_line_id']);

  pgm.sql(`
    COMMENT ON TABLE vendor_invoice_lines IS 'Line items for vendor invoices';
    COMMENT ON COLUMN vendor_invoice_lines.receipt_line_id IS 'Links to receipt line for three-way matching';
    COMMENT ON COLUMN vendor_invoice_lines.gl_account_id IS 'General ledger account for posting (if GL integration exists)';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('vendor_invoice_lines');
}
