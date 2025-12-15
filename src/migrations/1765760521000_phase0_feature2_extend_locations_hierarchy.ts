import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('locations', {
    parent_location_id: {
      type: 'uuid',
      references: 'locations',
      onDelete: 'SET NULL'
    },
    path: { type: 'text' },
    depth: { type: 'integer' }
  });

  pgm.createIndex('locations', 'parent_location_id', { name: 'idx_locations_parent' });
  pgm.addConstraint(
    'locations',
    'chk_locations_parent_not_self',
    'CHECK (parent_location_id IS NULL OR parent_location_id <> id)'
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('locations', 'chk_locations_parent_not_self');
  pgm.dropIndex('locations', 'idx_locations_parent');
  pgm.dropColumns('locations', ['parent_location_id', 'path', 'depth']);
}
