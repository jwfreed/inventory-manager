import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create currencies reference table
  pgm.createTable('currencies', {
    code: {
      type: 'char(3)',
      primaryKey: true,
      comment: 'ISO 4217 currency code (e.g., USD, EUR, GBP)'
    },
    name: {
      type: 'text',
      notNull: true,
      comment: 'Full currency name (e.g., United States Dollar)'
    },
    symbol: {
      type: 'text',
      notNull: true,
      comment: 'Currency symbol (e.g., $, €, £)'
    },
    decimal_places: {
      type: 'integer',
      notNull: true,
      default: 2,
      comment: 'Number of decimal places for this currency (typically 2, but can be 0 or 3)'
    },
    active: {
      type: 'boolean',
      notNull: true,
      default: true,
      comment: 'Whether this currency is active and can be used in transactions'
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('currencies', 'chk_currencies_decimal_places', 
    'CHECK (decimal_places >= 0 AND decimal_places <= 4)');

  pgm.createIndex('currencies', 'active', {
    name: 'idx_currencies_active',
    where: 'active = true'
  });

  // Create exchange rates table for historical rate tracking
  pgm.createTable('exchange_rates', {
    id: { type: 'uuid', primaryKey: true },
    from_currency: {
      type: 'char(3)',
      notNull: true,
      comment: 'Source currency code'
    },
    to_currency: {
      type: 'char(3)',
      notNull: true,
      comment: 'Target currency code'
    },
    rate: {
      type: 'numeric(18,8)',
      notNull: true,
      comment: 'Exchange rate from source to target (multiply source by this to get target)'
    },
    effective_date: {
      type: 'date',
      notNull: true,
      comment: 'Date when this rate is/was effective'
    },
    source: {
      type: 'text',
      notNull: false,
      comment: 'Source of the exchange rate (e.g., "manual", "api:openexchangerates", "api:ecb")'
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  // Add foreign key constraints
  pgm.addConstraint('exchange_rates', 'fk_exchange_rates_from_currency', {
    foreignKeys: {
      columns: 'from_currency',
      references: 'currencies(code)',
      onDelete: 'CASCADE'
    }
  });

  pgm.addConstraint('exchange_rates', 'fk_exchange_rates_to_currency', {
    foreignKeys: {
      columns: 'to_currency',
      references: 'currencies(code)',
      onDelete: 'CASCADE'
    }
  });

  // Add check constraints
  pgm.addConstraint('exchange_rates', 'chk_exchange_rates_rate_positive', 
    'CHECK (rate > 0)');

  pgm.addConstraint('exchange_rates', 'chk_exchange_rates_different_currencies',
    'CHECK (from_currency != to_currency)');

  // Add unique constraint to prevent duplicate rates for the same date/pair
  pgm.addConstraint('exchange_rates', 'uq_exchange_rates_currency_pair_date', {
    unique: ['from_currency', 'to_currency', 'effective_date']
  });

  // Add indexes for efficient rate lookups
  pgm.createIndex('exchange_rates', ['from_currency', 'to_currency', 'effective_date'], {
    name: 'idx_exchange_rates_lookup'
  });

  pgm.createIndex('exchange_rates', 'effective_date', {
    name: 'idx_exchange_rates_date'
  });

  // Seed common currencies
  pgm.sql(`
    INSERT INTO currencies (code, name, symbol, decimal_places, active) VALUES
    ('USD', 'United States Dollar', '$', 2, true),
    ('EUR', 'Euro', '€', 2, true),
    ('GBP', 'British Pound Sterling', '£', 2, true),
    ('CAD', 'Canadian Dollar', 'CA$', 2, true),
    ('AUD', 'Australian Dollar', 'A$', 2, true),
    ('JPY', 'Japanese Yen', '¥', 0, true),
    ('CNY', 'Chinese Yuan', '¥', 2, true),
    ('CHF', 'Swiss Franc', 'CHF', 2, true),
    ('SEK', 'Swedish Krona', 'kr', 2, true),
    ('NZD', 'New Zealand Dollar', 'NZ$', 2, true),
    ('MXN', 'Mexican Peso', 'MX$', 2, true),
    ('SGD', 'Singapore Dollar', 'S$', 2, true),
    ('HKD', 'Hong Kong Dollar', 'HK$', 2, true),
    ('NOK', 'Norwegian Krone', 'kr', 2, true),
    ('KRW', 'South Korean Won', '₩', 0, true),
    ('TRY', 'Turkish Lira', '₺', 2, true),
    ('INR', 'Indian Rupee', '₹', 2, true),
    ('RUB', 'Russian Ruble', '₽', 2, true),
    ('BRL', 'Brazilian Real', 'R$', 2, true),
    ('ZAR', 'South African Rand', 'R', 2, true)
  `);

  // Seed initial USD base rates (1:1 for USD, others as of example date)
  // These are placeholder rates and should be updated by the exchange rate sync job
  pgm.sql(`
    INSERT INTO exchange_rates (id, from_currency, to_currency, rate, effective_date, source) VALUES
    (gen_random_uuid(), 'USD', 'EUR', 0.92, '2026-01-01', 'manual'),
    (gen_random_uuid(), 'USD', 'GBP', 0.79, '2026-01-01', 'manual'),
    (gen_random_uuid(), 'USD', 'CAD', 1.36, '2026-01-01', 'manual'),
    (gen_random_uuid(), 'USD', 'AUD', 1.52, '2026-01-01', 'manual'),
    (gen_random_uuid(), 'USD', 'JPY', 148.50, '2026-01-01', 'manual'),
    (gen_random_uuid(), 'USD', 'CNY', 7.24, '2026-01-01', 'manual'),
    (gen_random_uuid(), 'USD', 'CHF', 0.89, '2026-01-01', 'manual'),
    (gen_random_uuid(), 'EUR', 'USD', 1.09, '2026-01-01', 'manual'),
    (gen_random_uuid(), 'GBP', 'USD', 1.27, '2026-01-01', 'manual'),
    (gen_random_uuid(), 'CAD', 'USD', 0.74, '2026-01-01', 'manual'),
    (gen_random_uuid(), 'AUD', 'USD', 0.66, '2026-01-01', 'manual')
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('exchange_rates');
  pgm.dropTable('currencies');
}
