import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('vendor_payments', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    payment_number: { type: 'text', notNull: true },
    vendor_id: { type: 'uuid', notNull: true, references: 'vendors' },
    payment_date: { type: 'date', notNull: true },
    payment_method: { type: 'text', notNull: true },
    reference_number: { type: 'text', notNull: false },
    payment_amount: { type: 'numeric(18,6)', notNull: true },
    currency: { type: 'text', notNull: true, default: 'USD' },
    exchange_rate: { type: 'numeric(18,6)', notNull: true, default: 1.0 },
    status: { type: 'text', notNull: true },
    notes: { type: 'text', notNull: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_by_user_id: { type: 'text', notNull: false },
    posted_at: { type: 'timestamptz', notNull: false },
    posted_by_user_id: { type: 'text', notNull: false }
  });

  pgm.addConstraint('vendor_payments', 'uq_vendor_payments_number', {
    unique: ['tenant_id', 'payment_number']
  });

  pgm.addConstraint('vendor_payments', 'chk_vendor_payments_status', {
    check: "status IN ('draft', 'posted', 'void', 'cleared')"
  });

  pgm.addConstraint('vendor_payments', 'chk_vendor_payments_method', {
    check: "payment_method IN ('check', 'ach', 'wire', 'credit_card', 'cash', 'other')"
  });

  pgm.createIndex('vendor_payments', ['tenant_id', 'vendor_id', 'status']);
  pgm.createIndex('vendor_payments', ['tenant_id', 'payment_date']);

  pgm.sql(`
    COMMENT ON TABLE vendor_payments IS 'Payments made to vendors';
    COMMENT ON COLUMN vendor_payments.reference_number IS 'Check number, wire confirmation, or other payment reference';
    COMMENT ON COLUMN vendor_payments.posted_at IS 'When payment was posted/cleared';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('vendor_payments');
}
