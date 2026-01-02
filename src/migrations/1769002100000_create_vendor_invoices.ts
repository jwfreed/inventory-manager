import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('vendor_invoices', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    invoice_number: { type: 'text', notNull: true },
    vendor_id: { type: 'uuid', notNull: true, references: 'vendors' },
    purchase_order_id: { type: 'uuid', notNull: false, references: 'purchase_orders' },
    invoice_date: { type: 'date', notNull: true },
    due_date: { type: 'date', notNull: true },
    gl_date: { type: 'date', notNull: false },
    currency: { type: 'text', notNull: true, default: 'USD' },
    exchange_rate: { type: 'numeric(18,6)', notNull: true, default: 1.0 },
    subtotal: { type: 'numeric(18,6)', notNull: true },
    tax_amount: { type: 'numeric(18,6)', notNull: true, default: 0 },
    freight_amount: { type: 'numeric(18,6)', notNull: true, default: 0 },
    discount_amount: { type: 'numeric(18,6)', notNull: true, default: 0 },
    total_amount: { type: 'numeric(18,6)', notNull: true },
    status: { type: 'text', notNull: true },
    payment_term_id: { type: 'uuid', notNull: false, references: 'vendor_payment_terms' },
    vendor_invoice_number: { type: 'text', notNull: false },
    notes: { type: 'text', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_by_user_id: { type: 'text', notNull: false },
    approved_at: { type: 'timestamptz', notNull: false },
    approved_by_user_id: { type: 'text', notNull: false }
  });

  pgm.addConstraint('vendor_invoices', 'uq_vendor_invoices_number', {
    unique: ['tenant_id', 'invoice_number']
  });

  pgm.addConstraint('vendor_invoices', 'chk_vendor_invoices_status', {
    check: "status IN ('draft', 'pending_approval', 'approved', 'paid', 'partially_paid', 'void')"
  });

  pgm.addConstraint('vendor_invoices', 'chk_vendor_invoices_amounts', {
    check: 'total_amount = subtotal + tax_amount + freight_amount - discount_amount'
  });

  pgm.createIndex('vendor_invoices', ['tenant_id', 'vendor_id', 'status']);
  pgm.createIndex('vendor_invoices', ['tenant_id', 'invoice_date']);
  pgm.createIndex('vendor_invoices', ['tenant_id', 'due_date']);
  pgm.createIndex('vendor_invoices', ['tenant_id', 'purchase_order_id']);

  pgm.sql(`
    COMMENT ON TABLE vendor_invoices IS 'Vendor invoices for accounts payable tracking';
    COMMENT ON COLUMN vendor_invoices.vendor_invoice_number IS 'Invoice number from the vendor (their reference)';
    COMMENT ON COLUMN vendor_invoices.gl_date IS 'General ledger posting date';
    COMMENT ON COLUMN vendor_invoices.exchange_rate IS 'Exchange rate for multi-currency support';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('vendor_invoices');
}
