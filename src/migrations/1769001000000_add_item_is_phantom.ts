import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('items', {
    is_phantom: { type: 'boolean', notNull: true, default: false }
  });

  pgm.createIndex('items', 'is_phantom', { name: 'idx_items_is_phantom' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('items', 'is_phantom');
}
