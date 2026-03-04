import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE
      v_source_count integer := 0;
      v_upserted_count integer := 0;
    BEGIN
      SELECT COUNT(*)
        INTO v_source_count
        FROM uom_conversions
       WHERE trim(from_uom) <> ''
         AND trim(to_uom) <> ''
         AND factor > 0;

      WITH upserted AS (
        INSERT INTO item_uom_overrides (
          id,
          tenant_id,
          item_id,
          from_uom,
          to_uom,
          multiplier,
          active,
          created_at,
          updated_at
        )
        SELECT
          gen_random_uuid(),
          c.tenant_id,
          c.item_id,
          lower(c.from_uom),
          lower(c.to_uom),
          c.factor,
          true,
          COALESCE(c.created_at, now()),
          now()
        FROM uom_conversions c
        WHERE trim(c.from_uom) <> ''
          AND trim(c.to_uom) <> ''
          AND c.factor > 0
        ON CONFLICT (tenant_id, item_id, from_uom, to_uom) WHERE active = true
        DO NOTHING
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_upserted_count FROM upserted;

      RAISE NOTICE 'item_uom_overrides_backfill source=% upserted=% skipped=%',
        v_source_count,
        v_upserted_count,
        GREATEST(v_source_count - v_upserted_count, 0);
    END $$;
  `);
}

export async function down(_pgm: MigrationBuilder): Promise<void> {
  // Data backfill is intentionally non-reversible.
}
