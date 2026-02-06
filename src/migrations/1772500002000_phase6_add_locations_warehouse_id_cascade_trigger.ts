import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION trg_locations_warehouse_id_cascade()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_new_warehouse_id uuid;
    BEGIN
      IF OLD.parent_location_id IS NOT DISTINCT FROM NEW.parent_location_id THEN
        RETURN NEW;
      END IF;

      PERFORM pg_advisory_xact_lock(hashtext('reparent:' || NEW.tenant_id::text));

      IF NEW.type = 'warehouse' THEN
        v_new_warehouse_id := NEW.id;
      ELSE
        SELECT warehouse_id
          INTO v_new_warehouse_id
          FROM locations
         WHERE id = NEW.parent_location_id
           AND tenant_id = NEW.tenant_id;

        IF v_new_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'PARENT_WAREHOUSE_ID_MISSING';
        END IF;
      END IF;

      IF v_new_warehouse_id IS NOT DISTINCT FROM OLD.warehouse_id THEN
        RETURN NEW;
      END IF;

      UPDATE locations
         SET warehouse_id = v_new_warehouse_id
       WHERE tenant_id = NEW.tenant_id
         AND id = NEW.id;

      PERFORM cascade_warehouse_id_to_descendants(
        NEW.tenant_id,
        NEW.id,
        v_new_warehouse_id
      );

      RETURN NEW;
    END;
    $$;
  `);

  pgm.sql(`
    CREATE TRIGGER trg_locations_warehouse_id_cascade
    AFTER UPDATE ON locations
    FOR EACH ROW
    EXECUTE FUNCTION trg_locations_warehouse_id_cascade();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_locations_warehouse_id_cascade ON locations;
  `);

  pgm.sql(`
    DROP FUNCTION IF EXISTS trg_locations_warehouse_id_cascade();
  `);
}

