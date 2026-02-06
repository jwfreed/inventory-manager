import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION trg_locations_warehouse_id_derive()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_parent_wh uuid;
    BEGIN
      IF NEW.type = 'warehouse' THEN
        NEW.warehouse_id := NEW.id;
        RETURN NEW;
      END IF;

      IF NEW.parent_location_id IS NULL THEN
        RAISE EXCEPTION 'PARENT_WAREHOUSE_ID_MISSING';
      END IF;

      SELECT warehouse_id
        INTO v_parent_wh
        FROM locations
       WHERE tenant_id = NEW.tenant_id
         AND id = NEW.parent_location_id;

      IF v_parent_wh IS NULL THEN
        RAISE EXCEPTION 'PARENT_WAREHOUSE_ID_MISSING';
      END IF;

      NEW.warehouse_id := v_parent_wh;
      RETURN NEW;
    END;
    $$;
  `);

  pgm.sql(`
    CREATE TRIGGER trg_locations_warehouse_id_derive
    BEFORE INSERT ON locations
    FOR EACH ROW
    EXECUTE FUNCTION trg_locations_warehouse_id_derive();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_locations_warehouse_id_derive ON locations;
  `);
  pgm.sql(`
    DROP FUNCTION IF EXISTS trg_locations_warehouse_id_derive();
  `);
}

