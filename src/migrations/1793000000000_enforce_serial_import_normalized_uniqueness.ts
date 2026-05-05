import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE
      blank_lot_count bigint;
      lot_tenant_mismatch record;
      duplicate_lot record;
      duplicate_import_serial record;
      invalid_serial_quantity_count bigint;
    BEGIN
      SELECT COUNT(*)
        INTO blank_lot_count
        FROM lots
       WHERE btrim(lot_code) = '';

      IF blank_lot_count > 0 THEN
        RAISE EXCEPTION 'LOTS_BLANK_LOT_CODE_EXISTING_ROWS count=%', blank_lot_count
          USING ERRCODE = '23514';
      END IF;

      SELECT l.id, l.tenant_id AS lot_tenant_id, i.tenant_id AS item_tenant_id
        INTO lot_tenant_mismatch
        FROM lots l
        JOIN items i ON i.id = l.item_id
       WHERE l.tenant_id <> i.tenant_id
       LIMIT 1;

      IF FOUND THEN
        RAISE EXCEPTION 'LOTS_ITEM_TENANT_MISMATCH lot_id=%, lot_tenant_id=%, item_tenant_id=%',
          lot_tenant_mismatch.id,
          lot_tenant_mismatch.lot_tenant_id,
          lot_tenant_mismatch.item_tenant_id
          USING ERRCODE = '23503';
      END IF;

      SELECT tenant_id, item_id, lower(btrim(lot_code)) AS normalized_lot_code, COUNT(*) AS duplicate_count
        INTO duplicate_lot
        FROM lots
       GROUP BY tenant_id, item_id, lower(btrim(lot_code))
      HAVING COUNT(*) > 1
       LIMIT 1;

      IF FOUND THEN
        RAISE EXCEPTION 'LOTS_NORMALIZED_LOT_CODE_DUPLICATE tenant_id=%, item_id=%, normalized_lot_code=%, count=%',
          duplicate_lot.tenant_id,
          duplicate_lot.item_id,
          duplicate_lot.normalized_lot_code,
          duplicate_lot.duplicate_count
          USING ERRCODE = '23505';
      END IF;

      SELECT tenant_id,
             lower(btrim(normalized->>'sku')) AS normalized_sku,
             lower(btrim(serial_number)) AS normalized_serial_number,
             COUNT(*) AS duplicate_count
        INTO duplicate_import_serial
        FROM import_job_rows
       WHERE serial_number IS NOT NULL
         AND btrim(serial_number) <> ''
         AND status IN ('valid', 'applied')
         AND normalized @> '{"requiresSerial": true}'::jsonb
         AND btrim(COALESCE(normalized->>'sku', '')) <> ''
       GROUP BY tenant_id, lower(btrim(normalized->>'sku')), lower(btrim(serial_number))
      HAVING COUNT(*) > 1
       LIMIT 1;

      IF FOUND THEN
        RAISE EXCEPTION 'IMPORT_JOB_ROWS_NORMALIZED_SERIAL_DUPLICATE tenant_id=%, sku=%, serial=%, count=%',
          duplicate_import_serial.tenant_id,
          duplicate_import_serial.normalized_sku,
          duplicate_import_serial.normalized_serial_number,
          duplicate_import_serial.duplicate_count
          USING ERRCODE = '23505';
      END IF;

      SELECT COUNT(*)
        INTO invalid_serial_quantity_count
        FROM import_job_rows
       WHERE status IN ('valid', 'applied')
         AND normalized @> '{"requiresSerial": true}'::jsonb
         AND (
           jsonb_typeof(normalized->'quantity') <> 'number'
           OR (normalized->>'quantity')::numeric <> 1
         );

      IF invalid_serial_quantity_count > 0 THEN
        RAISE EXCEPTION 'IMPORT_JOB_ROWS_SERIAL_QUANTITY_NOT_ONE count=%', invalid_serial_quantity_count
          USING ERRCODE = '23514';
      END IF;
    END $$;
  `);

  pgm.sql(`
    ALTER TABLE lots
      ADD CONSTRAINT chk_lots_lot_code_not_blank
      CHECK (btrim(lot_code) <> '');

    ALTER TABLE import_job_rows
      ADD CONSTRAINT chk_import_job_rows_serial_number_not_blank
      CHECK (serial_number IS NULL OR btrim(serial_number) <> '');

    ALTER TABLE import_job_rows
      ADD CONSTRAINT chk_import_job_rows_serial_quantity_one
      CHECK (
        status NOT IN ('valid', 'applied')
        OR NOT (normalized @> '{"requiresSerial": true}'::jsonb)
        OR (
          jsonb_typeof(normalized->'quantity') = 'number'
          AND (normalized->>'quantity')::numeric = 1
        )
      );

    ALTER TABLE lots
      ADD CONSTRAINT fk_lots_item_tenant
      FOREIGN KEY (tenant_id, item_id)
      REFERENCES items(tenant_id, id)
      ON DELETE RESTRICT;

    CREATE UNIQUE INDEX idx_lots_tenant_item_lot_code_normalized_unique
      ON lots (tenant_id, item_id, lower(btrim(lot_code)));

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
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_import_job_rows_tenant_sku_serial_normalized_unique;
    DROP INDEX IF EXISTS idx_lots_tenant_item_lot_code_normalized_unique;

    ALTER TABLE import_job_rows
      DROP CONSTRAINT IF EXISTS chk_import_job_rows_serial_quantity_one;

    ALTER TABLE import_job_rows
      DROP CONSTRAINT IF EXISTS chk_import_job_rows_serial_number_not_blank;

    ALTER TABLE lots
      DROP CONSTRAINT IF EXISTS fk_lots_item_tenant;

    ALTER TABLE lots
      DROP CONSTRAINT IF EXISTS chk_lots_lot_code_not_blank;
  `);
}
