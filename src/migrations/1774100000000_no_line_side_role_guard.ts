import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role_no_line_side;

    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role_no_line_side
      CHECK (
        role IS NULL
        OR LOWER(role) NOT IN ('line_side', 'line-side', 'line side', 'lineside', 'staging')
      );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role_no_line_side;
  `);
}
