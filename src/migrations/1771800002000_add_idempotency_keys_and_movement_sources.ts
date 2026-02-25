import type { MigrationBuilder } from 'node-pg-migrate';

const IDEMPOTENCY_STATUS_VALUES = "('IN_PROGRESS','SUCCEEDED','FAILED')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key text PRIMARY KEY,
      request_hash text NOT NULL,
      status text NOT NULL,
      response_ref text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'idempotency_keys'::regclass
           AND conname = 'chk_idempotency_status'
      ) THEN
        ALTER TABLE idempotency_keys
          ADD CONSTRAINT chk_idempotency_status
          CHECK (status IN ${IDEMPOTENCY_STATUS_VALUES});
      END IF;
    END
    $$;
  `);

  pgm.sql(`
    ALTER TABLE inventory_movements
      ADD COLUMN IF NOT EXISTS source_type text;
    ALTER TABLE inventory_movements
      ADD COLUMN IF NOT EXISTS source_id text;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_movements_source
      ON inventory_movements (tenant_id, source_type, source_id, movement_type)
      WHERE source_type IS NOT NULL AND source_id IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP INDEX IF EXISTS uq_inventory_movements_source;`);
  pgm.sql(`ALTER TABLE inventory_movements DROP COLUMN IF EXISTS source_type;`);
  pgm.sql(`ALTER TABLE inventory_movements DROP COLUMN IF EXISTS source_id;`);
  pgm.sql(`ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS chk_idempotency_status;`);
  pgm.sql(`DROP TABLE IF EXISTS idempotency_keys;`);
}
