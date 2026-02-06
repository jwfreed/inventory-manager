import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addConstraint('locations', 'chk_locations_orphan_is_warehouse', {
    check: `(parent_location_id IS NOT NULL) OR (type = 'warehouse')`
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('locations', 'chk_locations_orphan_is_warehouse', { ifExists: true });
}
