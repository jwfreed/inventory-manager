import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Ensure base currency exists for defaults.
  pgm.sql(`
    INSERT INTO currencies (code, name, symbol, decimal_places, active)
    VALUES ('THB', 'Thai Baht', 'THB', 2, true)
    ON CONFLICT (code) DO NOTHING
  `);

  pgm.addColumn('users', {
    base_currency: {
      type: 'text',
      notNull: false,
      comment: 'User-configured base currency for cost conversions.'
    }
  });

  pgm.sql(`
    UPDATE users
    SET base_currency = 'THB'
    WHERE base_currency IS NULL
  `);

  pgm.alterColumn('users', 'base_currency', {
    notNull: true,
    default: "'THB'"
  });

  pgm.addConstraint('users', 'fk_users_base_currency', {
    foreignKeys: {
      columns: 'base_currency',
      references: 'currencies(code)',
      onDelete: 'RESTRICT'
    }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('users', 'base_currency');
}
