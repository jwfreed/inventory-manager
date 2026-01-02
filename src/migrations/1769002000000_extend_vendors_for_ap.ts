import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add AP-related columns to vendors table
  pgm.addColumns('vendors', {
    payment_term_id: { type: 'uuid', notNull: false, references: 'vendor_payment_terms' },
    currency: { type: 'text', notNull: false, default: 'USD' },
    tax_id: { type: 'text', notNull: false },
    address_line1: { type: 'text', notNull: false },
    address_line2: { type: 'text', notNull: false },
    city: { type: 'text', notNull: false },
    state: { type: 'text', notNull: false },
    postal_code: { type: 'text', notNull: false },
    country: { type: 'text', notNull: false, default: 'US' }
  });

  pgm.createIndex('vendors', ['tenant_id', 'payment_term_id']);

  pgm.sql(`
    COMMENT ON COLUMN vendors.payment_term_id IS 'Default payment terms for this vendor';
    COMMENT ON COLUMN vendors.currency IS 'Currency code (ISO 4217)';
    COMMENT ON COLUMN vendors.tax_id IS 'Tax identification number (EIN, VAT, etc.)';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('vendors', [
    'payment_term_id',
    'currency',
    'tax_id',
    'address_line1',
    'address_line2',
    'city',
    'state',
    'postal_code',
    'country'
  ]);
}
