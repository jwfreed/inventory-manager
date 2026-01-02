import { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('vendor_payment_terms', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true },
    code: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    discount_days: { type: 'integer', notNull: false },
    discount_percent: { type: 'numeric(5,2)', notNull: false },
    net_days: { type: 'integer', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('vendor_payment_terms', 'uq_vendor_payment_terms_code', {
    unique: ['tenant_id', 'code']
  });

  pgm.createIndex('vendor_payment_terms', ['tenant_id', 'active']);

  pgm.sql(`
    COMMENT ON TABLE vendor_payment_terms IS 'Master data for vendor payment terms (e.g., NET30, 2/10 NET30)';
    COMMENT ON COLUMN vendor_payment_terms.discount_days IS 'Number of days to receive discount (e.g., 10 in "2/10 NET30")';
    COMMENT ON COLUMN vendor_payment_terms.discount_percent IS 'Discount percentage if paid early (e.g., 2 for 2%)';
    COMMENT ON COLUMN vendor_payment_terms.net_days IS 'Total days until payment is due (e.g., 30 in "NET30")';
  `);

  // Insert common payment terms
  pgm.sql(`
    INSERT INTO vendor_payment_terms (id, tenant_id, code, name, discount_days, discount_percent, net_days, active, created_at, updated_at)
    SELECT 
      gen_random_uuid(),
      id,
      'NET30',
      'Net 30 Days',
      NULL,
      NULL,
      30,
      true,
      now(),
      now()
    FROM tenants;

    INSERT INTO vendor_payment_terms (id, tenant_id, code, name, discount_days, discount_percent, net_days, active, created_at, updated_at)
    SELECT 
      gen_random_uuid(),
      id,
      'NET60',
      'Net 60 Days',
      NULL,
      NULL,
      60,
      true,
      now(),
      now()
    FROM tenants;

    INSERT INTO vendor_payment_terms (id, tenant_id, code, name, discount_days, discount_percent, net_days, active, created_at, updated_at)
    SELECT 
      gen_random_uuid(),
      id,
      '2/10_NET30',
      '2% 10 Days, Net 30',
      10,
      2.00,
      30,
      true,
      now(),
      now()
    FROM tenants;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('vendor_payment_terms');
}
