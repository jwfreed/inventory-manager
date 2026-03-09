import type { MigrationBuilder } from 'node-pg-migrate';

const HASH_FORMAT_CONSTRAINT = 'chk_inventory_movements_deterministic_hash_format';
const HASH_REGEX = '^[0-9a-f]{64}$';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE
      v_invalid_hash_count integer := 0;
    BEGIN
      SELECT COUNT(*)
        INTO v_invalid_hash_count
        FROM inventory_movements
       WHERE movement_deterministic_hash !~ '${HASH_REGEX}';

      IF v_invalid_hash_count > 0 THEN
        RAISE EXCEPTION
          'MOVEMENT_HASH_FORMAT_PRECHECK_FAILED invalid_rows=%',
          v_invalid_hash_count;
      END IF;
    END $$;
  `);

  pgm.sql(`
    ALTER TABLE inventory_movements
      ADD CONSTRAINT ${HASH_FORMAT_CONSTRAINT}
      CHECK (movement_deterministic_hash ~ '${HASH_REGEX}');
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('inventory_movements', HASH_FORMAT_CONSTRAINT, {
    ifExists: true
  });
}
