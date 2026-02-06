import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();
  pgm.sql(`
    CREATE INDEX CONCURRENTLY idx_locations_warehouse_id
    ON locations (tenant_id, warehouse_id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();
  pgm.sql(`
    DROP INDEX CONCURRENTLY IF EXISTS idx_locations_warehouse_id;
  `);
}
