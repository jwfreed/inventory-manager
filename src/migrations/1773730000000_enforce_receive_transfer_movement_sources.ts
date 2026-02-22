import type { MigrationBuilder } from 'node-pg-migrate';

const CONSTRAINT_NAME = 'chk_inventory_movements_receive_transfer_source_required';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = '${CONSTRAINT_NAME}'
      ) THEN
        ALTER TABLE inventory_movements
          ADD CONSTRAINT ${CONSTRAINT_NAME}
          CHECK (
            movement_type NOT IN ('receive', 'transfer')
            OR (
              source_type IS NOT NULL
              AND BTRIM(source_type) <> ''
              AND source_id IS NOT NULL
              AND BTRIM(source_id) <> ''
            )
          ) NOT VALID;
      END IF;
    END
    $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('inventory_movements', CONSTRAINT_NAME, { ifExists: true });
}
