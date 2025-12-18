import { type MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('items', {
    type: { type: 'text', notNull: true, default: 'raw' },
    default_uom: { type: 'text' },
    default_location_id: { type: 'uuid', references: '"locations"', onDelete: 'SET NULL' }
  });

  pgm.addConstraint(
    'items',
    'chk_items_type_valid',
    "CHECK (type IN ('raw','wip','finished','packaging'))"
  );

  pgm.createIndex('items', 'type', { name: 'idx_items_type' });
  pgm.createIndex('items', 'default_location_id', { name: 'idx_items_default_location' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('items', 'default_location_id', { name: 'idx_items_default_location' });
  pgm.dropIndex('items', 'type', { name: 'idx_items_type' });
  pgm.dropConstraint('items', 'chk_items_type_valid');
  pgm.dropColumns('items', ['type', 'default_uom', 'default_location_id']);
}
