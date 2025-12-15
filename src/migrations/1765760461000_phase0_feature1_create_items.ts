import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('items', {
    id: { type: 'uuid', primaryKey: true },
    sku: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.createIndex('items', 'active', {
    name: 'idx_items_active'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('items');
}
