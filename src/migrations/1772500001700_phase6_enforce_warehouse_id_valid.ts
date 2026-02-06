import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE locations
    ADD CONSTRAINT chk_locations_warehouse_id_valid
    CHECK (
      (type = 'warehouse' AND warehouse_id = id)
      OR
      (type <> 'warehouse' AND warehouse_id IS NOT NULL)
    );
  `);

  pgm.sql(`
    ALTER TABLE locations
    ALTER COLUMN warehouse_id SET NOT NULL;
  `);

  /*
    -- Should return 0 rows
    SELECT * FROM locations
    WHERE type='warehouse' AND warehouse_id <> id;

    SELECT * FROM locations
    WHERE type <> 'warehouse' AND warehouse_id IS NULL;
  */
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE locations
    ALTER COLUMN warehouse_id DROP NOT NULL;
  `);

  pgm.sql(`
    ALTER TABLE locations
    DROP CONSTRAINT chk_locations_warehouse_id_valid;
  `);
}

