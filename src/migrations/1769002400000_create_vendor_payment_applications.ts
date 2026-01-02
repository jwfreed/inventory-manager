import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('vendor_payment_applications', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    vendor_payment_id: { type: 'uuid', notNull: true, references: 'vendor_payments', onDelete: 'CASCADE' },
    vendor_invoice_id: { type: 'uuid', notNull: true, references: 'vendor_invoices', onDelete: 'CASCADE' },
    applied_amount: { type: 'numeric(18,6)', notNull: true },
    discount_taken: { type: 'numeric(18,6)', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('vendor_payment_applications', 'chk_payment_applications_amount', {
    check: 'applied_amount > 0'
  });

  pgm.createIndex('vendor_payment_applications', ['tenant_id', 'vendor_payment_id']);
  pgm.createIndex('vendor_payment_applications', ['tenant_id', 'vendor_invoice_id']);

  pgm.sql(`
    COMMENT ON TABLE vendor_payment_applications IS 'Links payments to invoices they pay';
    COMMENT ON COLUMN vendor_payment_applications.discount_taken IS 'Early payment discount amount taken';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('vendor_payment_applications');
}
