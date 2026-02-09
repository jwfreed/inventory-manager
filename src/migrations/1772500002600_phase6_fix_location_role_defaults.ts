import type { MigrationBuilder } from 'node-pg-migrate';

const LOCATION_ROLE_VALUES = "('SELLABLE','QA','HOLD','REJECT','SCRAP')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Phase 6: warehouse roots must be role-less and non-sellable.
  // Ensure schema allows role NULL and is_sellable default false.
  pgm.sql(`
    ALTER TABLE locations
      ALTER COLUMN role DROP DEFAULT;

    ALTER TABLE locations
      ALTER COLUMN is_sellable SET DEFAULT false;

    ALTER TABLE locations
      ALTER COLUMN role DROP NOT NULL;

    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role_sellable;
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role;

    -- Correct legacy warehouse roots created under old defaults.
    UPDATE locations
       SET role = NULL,
           is_sellable = false
     WHERE type = 'warehouse'
       AND parent_location_id IS NULL
       AND role = 'SELLABLE'
       AND is_sellable = true;

    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role
      CHECK (role IS NULL OR role IN ${LOCATION_ROLE_VALUES});

    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role_sellable
      CHECK (role IS NULL OR ((role = 'SELLABLE') = is_sellable));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role_sellable;
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role;

    ALTER TABLE locations
      ALTER COLUMN role SET NOT NULL;
    ALTER TABLE locations
      ALTER COLUMN role SET DEFAULT 'SELLABLE';
    ALTER TABLE locations
      ALTER COLUMN is_sellable SET DEFAULT true;

    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role
      CHECK (role IN ${LOCATION_ROLE_VALUES});
    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role_sellable
      CHECK ((role = 'SELLABLE') = is_sellable);
  `);
}
