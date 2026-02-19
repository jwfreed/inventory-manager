import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Multi-tenant topology requires location code collisions to be allowed across tenants.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_tenant_code
      ON locations (tenant_id, code);
  `);

  pgm.sql(`
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS locations_code_key;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE locations
      ADD CONSTRAINT locations_code_key UNIQUE (code);
  `);

  pgm.sql(`
    DROP INDEX IF EXISTS uq_locations_tenant_code;
  `);
}
