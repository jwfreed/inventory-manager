import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Add currency and pricing fields to sales_order_lines
  pgm.addColumn('sales_order_lines', {
    unit_price: {
      type: 'numeric(18,6)',
      notNull: false,
      comment: 'Unit selling price in the currency specified by currency_code'
    },
    currency_code: {
      type: 'char(3)',
      notNull: false,
      references: 'currencies(code)',
      comment: 'ISO 4217 currency code for this line (e.g., USD, EUR)'
    },
    exchange_rate_to_base: {
      type: 'numeric(18,8)',
      notNull: false,
      comment: 'Exchange rate from line currency to base currency at transaction time. Multiply line amount by this to get base amount.'
    },
    line_amount: {
      type: 'numeric(18,6)',
      notNull: false,
      comment: 'Line total in line currency: unit_price * quantity_ordered'
    },
    base_amount: {
      type: 'numeric(18,6)',
      notNull: false,
      comment: 'Line total in base currency: line_amount * exchange_rate_to_base. Used for reporting.'
    }
  });

  // Add check constraints
  pgm.addConstraint('sales_order_lines', 'chk_so_lines_unit_price_nonnegative', {
    check: 'unit_price IS NULL OR unit_price >= 0'
  });

  pgm.addConstraint('sales_order_lines', 'chk_so_lines_exchange_rate_positive', {
    check: 'exchange_rate_to_base IS NULL OR exchange_rate_to_base > 0'
  });

  pgm.addConstraint('sales_order_lines', 'chk_so_lines_line_amount_nonnegative', {
    check: 'line_amount IS NULL OR line_amount >= 0'
  });

  pgm.addConstraint('sales_order_lines', 'chk_so_lines_base_amount_nonnegative', {
    check: 'base_amount IS NULL OR base_amount >= 0'
  });

  // Add consistency constraint: if any currency field is set, currency_code must be set
  pgm.addConstraint('sales_order_lines', 'chk_so_lines_currency_consistency', {
    check: `(
      (unit_price IS NULL AND currency_code IS NULL AND exchange_rate_to_base IS NULL AND line_amount IS NULL AND base_amount IS NULL)
      OR
      (currency_code IS NOT NULL)
    )`
  });

  // Add index on currency_code for reporting
  pgm.createIndex('sales_order_lines', 'currency_code', {
    name: 'idx_so_lines_currency'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('sales_order_lines', 'currency_code', { name: 'idx_so_lines_currency', ifExists: true });
  
  pgm.dropConstraint('sales_order_lines', 'chk_so_lines_currency_consistency', { ifExists: true });
  pgm.dropConstraint('sales_order_lines', 'chk_so_lines_base_amount_nonnegative', { ifExists: true });
  pgm.dropConstraint('sales_order_lines', 'chk_so_lines_line_amount_nonnegative', { ifExists: true });
  pgm.dropConstraint('sales_order_lines', 'chk_so_lines_exchange_rate_positive', { ifExists: true });
  pgm.dropConstraint('sales_order_lines', 'chk_so_lines_unit_price_nonnegative', { ifExists: true });
  
  pgm.dropColumns('sales_order_lines', [
    'unit_price',
    'currency_code',
    'exchange_rate_to_base',
    'line_amount',
    'base_amount'
  ]);
}
