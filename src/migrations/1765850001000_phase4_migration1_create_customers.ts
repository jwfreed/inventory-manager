import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('customers', {
    id: { type: 'uuid', primaryKey: true },
    code: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    email: { type: 'text' },
    phone: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.createIndex('customers', 'active', { name: 'idx_customers_active' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('customers');
}

