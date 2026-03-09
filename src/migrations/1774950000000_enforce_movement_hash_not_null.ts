import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE
      v_missing_hash_count integer := 0;
    BEGIN
      SELECT COUNT(*)
        INTO v_missing_hash_count
        FROM inventory_movements
       WHERE movement_deterministic_hash IS NULL;

      IF v_missing_hash_count > 0 THEN
        RAISE EXCEPTION
          'MOVEMENT_HASH_NOT_NULL_PRECHECK_FAILED missing_rows=%',
          v_missing_hash_count;
      END IF;
    END $$;
  `);

  pgm.sql(`
    ALTER TABLE inventory_movements
      ALTER COLUMN movement_deterministic_hash SET NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE inventory_movements
      ALTER COLUMN movement_deterministic_hash DROP NOT NULL;
  `);
}
