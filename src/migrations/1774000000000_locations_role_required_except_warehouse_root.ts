import type { MigrationBuilder } from 'node-pg-migrate';

const LOCATION_ROLE_VALUES = "('SELLABLE','QA','HOLD','REJECT','SCRAP')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE locations
      ADD COLUMN IF NOT EXISTS role text;

    ALTER TABLE locations
      ADD COLUMN IF NOT EXISTS is_sellable boolean;

    ALTER TABLE locations
      ALTER COLUMN role DROP NOT NULL;

    ALTER TABLE locations
      ALTER COLUMN role DROP DEFAULT;

    ALTER TABLE locations
      ALTER COLUMN is_sellable SET DEFAULT false;

    UPDATE locations
       SET is_sellable = COALESCE(is_sellable, false);

    UPDATE locations
       SET role = CASE
         WHEN type = 'scrap' THEN 'SCRAP'
         WHEN is_sellable = true THEN 'SELLABLE'
         WHEN code ILIKE '%qa%' OR name ILIKE '%qa%' OR name ILIKE '%quality%' OR name ILIKE '%inspect%' THEN 'QA'
         WHEN code ILIKE '%hold%' OR name ILIKE '%hold%' THEN 'HOLD'
         WHEN code ILIKE '%reject%' OR name ILIKE '%reject%' OR code ILIKE '%mrb%' OR name ILIKE '%mrb%' THEN 'REJECT'
         ELSE 'SCRAP'
       END
     WHERE role IS NULL
       AND NOT (type = 'warehouse' AND parent_location_id IS NULL);

    UPDATE locations
       SET is_sellable = false
     WHERE type = 'warehouse'
       AND parent_location_id IS NULL
       AND is_sellable IS DISTINCT FROM false;

    ALTER TABLE locations
      ALTER COLUMN is_sellable SET NOT NULL;

    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role;

    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role_sellable;

    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role_required_except_warehouse_root;

    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role
      CHECK (role IS NULL OR role IN ${LOCATION_ROLE_VALUES});

    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role_sellable
      CHECK (role IS NULL OR ((role = 'SELLABLE') = is_sellable));

    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role_required_except_warehouse_root
      CHECK (role IS NOT NULL OR (type = 'warehouse' AND parent_location_id IS NULL));

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'locations'::regclass
           AND conname = 'chk_locations_orphan_is_warehouse'
      ) THEN
        ALTER TABLE locations
          ADD CONSTRAINT chk_locations_orphan_is_warehouse
          CHECK ((parent_location_id IS NOT NULL) OR (type = 'warehouse'));
      END IF;
    END
    $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role_required_except_warehouse_root;
  `);
}
