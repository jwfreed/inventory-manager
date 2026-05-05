import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Preflight: fail fast on unresolvable SKUs and ambiguous SKU mappings.
  pgm.sql(`
    DO $$
    DECLARE
      unresolvable_count bigint;
      ambiguous_rec      record;
    BEGIN
      -- Any serial-tracked valid/applied row whose SKU cannot resolve to an item must block.
      SELECT COUNT(*)
        INTO unresolvable_count
        FROM import_job_rows ijr
       WHERE ijr.serial_number IS NOT NULL
         AND btrim(ijr.serial_number) <> ''
         AND ijr.status IN ('valid', 'applied')
         AND ijr.normalized @> '{"requiresSerial": true}'::jsonb
         AND NOT EXISTS (
           SELECT 1 FROM items i
            WHERE i.tenant_id = ijr.tenant_id
              AND lower(btrim(i.sku)) = lower(btrim(ijr.normalized->>'sku'))
         );

      IF unresolvable_count > 0 THEN
        RAISE EXCEPTION 'IMPORT_JOB_ROWS_UNRESOLVABLE_SKU_TO_ITEM count=%', unresolvable_count
          USING ERRCODE = '23503';
      END IF;

      -- Any tenant with more than one item sharing the same normalized SKU would produce an
      -- ambiguous backfill (UPDATE would match multiple items).  Fail early.
      SELECT tenant_id, lower(btrim(sku)) AS normalized_sku, COUNT(*) AS cnt
        INTO ambiguous_rec
        FROM items
       GROUP BY tenant_id, lower(btrim(sku))
      HAVING COUNT(*) > 1
       LIMIT 1;

      IF FOUND THEN
        RAISE EXCEPTION 'ITEMS_AMBIGUOUS_NORMALIZED_SKU tenant_id=%, sku=%, count=%',
          ambiguous_rec.tenant_id,
          ambiguous_rec.normalized_sku,
          ambiguous_rec.cnt
          USING ERRCODE = '23505';
      END IF;
    END $$;
  `);

  // Add item_id column nullable first — backfill precedes NOT NULL enforcement.
  pgm.addColumn('import_job_rows', {
    item_id: { type: 'uuid' }
  });

  // Backfill item_id from items lookup via normalized->>'sku' for all rows that carry a
  // resolvable SKU.  Rows belonging to 'items' or 'locations' jobs, or error rows with no
  // normalized payload, remain NULL and are outside the partial index predicate.
  pgm.sql(`
    UPDATE import_job_rows ijr
       SET item_id = i.id
      FROM items i
     WHERE i.tenant_id = ijr.tenant_id
       AND lower(btrim(i.sku)) = lower(btrim(ijr.normalized->>'sku'))
       AND ijr.normalized IS NOT NULL
       AND btrim(COALESCE(ijr.normalized->>'sku', '')) <> '';
  `);

  // FK mirrors the constraint already present on lots(tenant_id, item_id) → items(tenant_id, id).
  // NULL item_id rows satisfy the FK implicitly (PostgreSQL FK null semantics).
  pgm.sql(`
    ALTER TABLE import_job_rows
      ADD CONSTRAINT fk_import_job_rows_item_tenant
      FOREIGN KEY (tenant_id, item_id)
      REFERENCES items(tenant_id, id)
      ON DELETE RESTRICT;

    -- item_id must be present for any row that enters a stable state for a serial-tracked item.
    -- This prevents any in-app path from persisting an unresolved identity into the uniqueness domain.
    ALTER TABLE import_job_rows
      ADD CONSTRAINT chk_import_job_rows_serial_item_id_not_null
      CHECK (
        status NOT IN ('valid', 'applied')
        OR NOT (normalized @> '{"requiresSerial": true}'::jsonb)
        OR item_id IS NOT NULL
      );
  `);

  // Remove SKU-based staging identity index.
  pgm.sql(`
    DROP INDEX IF EXISTS idx_import_job_rows_tenant_sku_serial_normalized_unique;
  `);

  // Replace with item_id-based identity — aligns with lots(tenant_id, item_id, lot_code) semantics.
  // Partial predicate conditions are preserved exactly; SKU expression and SKU blank-check replaced
  // by item_id column reference and item_id IS NOT NULL guard.
  pgm.sql(`
    CREATE UNIQUE INDEX idx_import_job_rows_tenant_item_serial_normalized_unique
      ON import_job_rows (tenant_id, item_id, lower(btrim(serial_number)))
      WHERE serial_number IS NOT NULL
        AND btrim(serial_number) <> ''
        AND status IN ('valid', 'applied')
        AND normalized @> '{"requiresSerial": true}'::jsonb
        AND item_id IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_import_job_rows_tenant_item_serial_normalized_unique;

    ALTER TABLE import_job_rows
      DROP CONSTRAINT IF EXISTS chk_import_job_rows_serial_item_id_not_null;

    ALTER TABLE import_job_rows
      DROP CONSTRAINT IF EXISTS fk_import_job_rows_item_tenant;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX idx_import_job_rows_tenant_sku_serial_normalized_unique
      ON import_job_rows (
        tenant_id,
        lower(btrim(normalized->>'sku')),
        lower(btrim(serial_number))
      )
      WHERE serial_number IS NOT NULL
        AND btrim(serial_number) <> ''
        AND status IN ('valid', 'applied')
        AND normalized @> '{"requiresSerial": true}'::jsonb
        AND btrim(COALESCE(normalized->>'sku', '')) <> '';
  `);

  pgm.dropColumn('import_job_rows', 'item_id');
}
