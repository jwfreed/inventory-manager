import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE locations
      ADD COLUMN IF NOT EXISTS local_code text;
  `);

  pgm.sql(`
    DO $$
    DECLARE
      conflict_record RECORD;
    BEGIN
      SELECT tenant_id, warehouse_id, local_code, COUNT(*)::int AS duplicate_count
        INTO conflict_record
        FROM locations
       WHERE local_code IS NOT NULL
       GROUP BY tenant_id, warehouse_id, local_code
      HAVING COUNT(*) > 1
       LIMIT 1;

      IF FOUND THEN
        RAISE EXCEPTION
          'TOPOLOGY_LOCAL_CODE_CONFLICT tenant_id=% warehouse_id=% local_code=% duplicate_count=%',
          conflict_record.tenant_id,
          conflict_record.warehouse_id,
          conflict_record.local_code,
          conflict_record.duplicate_count;
      END IF;
    END $$;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_tenant_warehouse_local_code
      ON locations (tenant_id, warehouse_id, local_code)
      WHERE local_code IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS uq_locations_tenant_warehouse_local_code;
  `);

  pgm.sql(`
    ALTER TABLE locations
      DROP COLUMN IF EXISTS local_code;
  `);
}
