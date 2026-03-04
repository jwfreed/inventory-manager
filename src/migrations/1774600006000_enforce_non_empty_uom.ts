import type { MigrationBuilder } from 'node-pg-migrate';

const INVENTORY_BALANCE_UOM_NOT_BLANK = 'inventory_balance_uom_not_blank';
const INVENTORY_MOVEMENT_LINES_UOM_NOT_BLANK = 'inventory_movement_lines_uom_not_blank';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE
      v_balance_corrected integer := 0;
      v_balance_remaining integer := 0;
      v_movement_corrected integer := 0;
      v_movement_remaining integer := 0;
      r record;
    BEGIN
      WITH corrected AS (
        UPDATE inventory_balance b
           SET uom = 'EA'
          FROM items i
         WHERE b.item_id = i.id
           AND b.tenant_id = i.tenant_id
           AND trim(b.uom) = ''
           AND i.uom_dimension = 'count'
           AND NOT EXISTS (
             SELECT 1
               FROM inventory_balance existing
              WHERE existing.tenant_id = b.tenant_id
                AND existing.item_id = b.item_id
                AND existing.location_id = b.location_id
                AND lower(existing.uom) = 'ea'
                AND existing.ctid <> b.ctid
           )
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_balance_corrected FROM corrected;

      SELECT COUNT(*)
        INTO v_balance_remaining
        FROM inventory_balance
       WHERE trim(uom) = '';

      IF v_balance_remaining > 0 THEN
        FOR r IN
          SELECT tenant_id, item_id, location_id, uom
            FROM inventory_balance
           WHERE trim(uom) = ''
           ORDER BY tenant_id, item_id, location_id
           LIMIT 10
        LOOP
          RAISE NOTICE 'inventory_balance blank_uom sample tenant=% item=% location=% uom=%',
            r.tenant_id, r.item_id, r.location_id, quote_nullable(r.uom);
        END LOOP;
        RAISE EXCEPTION
          'UOM_BACKFILL_UNSAFE inventory_balance remaining_blank_rows=%',
          v_balance_remaining;
      END IF;

      WITH corrected AS (
        UPDATE inventory_movement_lines l
           SET uom = 'EA'
          FROM items i
         WHERE l.item_id = i.id
           AND l.tenant_id = i.tenant_id
           AND trim(l.uom) = ''
           AND i.uom_dimension = 'count'
        RETURNING 1
      )
      SELECT COUNT(*) INTO v_movement_corrected FROM corrected;

      SELECT COUNT(*)
        INTO v_movement_remaining
        FROM inventory_movement_lines
       WHERE trim(uom) = '';

      IF v_movement_remaining > 0 THEN
        FOR r IN
          SELECT tenant_id, id, item_id, uom
            FROM inventory_movement_lines
           WHERE trim(uom) = ''
           ORDER BY tenant_id, id
           LIMIT 10
        LOOP
          RAISE NOTICE 'inventory_movement_lines blank_uom sample tenant=% line_id=% item=% uom=%',
            r.tenant_id, r.id, r.item_id, quote_nullable(r.uom);
        END LOOP;
        RAISE EXCEPTION
          'UOM_BACKFILL_UNSAFE inventory_movement_lines remaining_blank_rows=%',
          v_movement_remaining;
      END IF;

      RAISE NOTICE 'uom_backfill inventory_balance corrected_rows=%', v_balance_corrected;
      RAISE NOTICE 'uom_backfill inventory_movement_lines corrected_rows=%', v_movement_corrected;
    END $$;
  `);

  pgm.sql(`
    ALTER TABLE inventory_balance
      DROP CONSTRAINT IF EXISTS ${INVENTORY_BALANCE_UOM_NOT_BLANK};
    ALTER TABLE inventory_balance
      ADD CONSTRAINT ${INVENTORY_BALANCE_UOM_NOT_BLANK}
      CHECK (trim(uom) <> '')
      NOT VALID;
    ALTER TABLE inventory_balance
      VALIDATE CONSTRAINT ${INVENTORY_BALANCE_UOM_NOT_BLANK};
  `);

  pgm.sql(`
    ALTER TABLE inventory_movement_lines
      DROP CONSTRAINT IF EXISTS ${INVENTORY_MOVEMENT_LINES_UOM_NOT_BLANK};
    ALTER TABLE inventory_movement_lines
      ADD CONSTRAINT ${INVENTORY_MOVEMENT_LINES_UOM_NOT_BLANK}
      CHECK (trim(uom) <> '')
      NOT VALID;
    ALTER TABLE inventory_movement_lines
      VALIDATE CONSTRAINT ${INVENTORY_MOVEMENT_LINES_UOM_NOT_BLANK};
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('inventory_movement_lines', INVENTORY_MOVEMENT_LINES_UOM_NOT_BLANK, { ifExists: true });
  pgm.dropConstraint('inventory_balance', INVENTORY_BALANCE_UOM_NOT_BLANK, { ifExists: true });
}
