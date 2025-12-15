import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('boms', {
    id: { type: 'uuid', primaryKey: true },
    bom_code: { type: 'text', notNull: true, unique: true },
    output_item_id: { type: 'uuid', notNull: true, references: 'items' },
    default_uom: { type: 'text', notNull: true },
    active: { type: 'boolean', notNull: true, default: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true }
  });

  pgm.createIndex('boms', 'output_item_id', { name: 'idx_boms_output_item' });
  pgm.createIndex('boms', 'active', { name: 'idx_boms_active' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('boms');
}
