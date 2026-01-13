import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('items', {
    standard_cost_currency: {
      type: 'text',
      notNull: false,
      references: 'currencies(code)',
      comment: 'ISO 4217 currency code for standard_cost (e.g., USD, EUR, THB)'
    },
    standard_cost_exchange_rate_to_base: {
      type: 'numeric(18,6)',
      notNull: false,
      comment: 'Exchange rate from standard_cost_currency to base currency at time of entry'
    },
    standard_cost_base: {
      type: 'numeric(18,6)',
      notNull: false,
      comment: 'Standard cost converted to base currency at time of entry'
    }
  });

  // Ensure base currency exists for backfill.
  pgm.sql(`
    INSERT INTO currencies (code, name, symbol, decimal_places, active)
    VALUES ('THB', 'Thai Baht', 'THB', 2, true)
    ON CONFLICT (code) DO NOTHING
  `);

  // Backfill existing rows to satisfy constraint.
  // Assume existing standard_cost values are already in the base currency.
  pgm.sql(`
    UPDATE items
    SET standard_cost_currency = 'THB',
        standard_cost_exchange_rate_to_base = 1,
        standard_cost_base = standard_cost
    WHERE standard_cost IS NOT NULL
      AND standard_cost_currency IS NULL
  `);

  pgm.addConstraint('items', 'chk_items_standard_cost_currency_consistency', {
    check: `
      (standard_cost IS NULL AND standard_cost_currency IS NULL AND standard_cost_exchange_rate_to_base IS NULL AND standard_cost_base IS NULL)
      OR
      (standard_cost IS NOT NULL AND standard_cost_currency IS NOT NULL)
    `
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('items', 'chk_items_standard_cost_currency_consistency', { ifExists: true });
  pgm.dropColumn('items', [
    'standard_cost_currency',
    'standard_cost_exchange_rate_to_base',
    'standard_cost_base'
  ]);
}
