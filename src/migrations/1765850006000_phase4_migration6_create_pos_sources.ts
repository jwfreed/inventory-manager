import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('pos_sources', {
    id: { type: 'uuid', primaryKey: true },
    code: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.createIndex('pos_sources', 'active', { name: 'idx_pos_sources_active' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('pos_sources');
}

