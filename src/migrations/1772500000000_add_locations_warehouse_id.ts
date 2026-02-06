import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('locations', {
    warehouse_id: { type: 'uuid', references: 'locations', onDelete: 'SET NULL' }
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('locations', 'warehouse_id', { ifExists: true });
}
