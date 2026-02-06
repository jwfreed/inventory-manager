import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION trg_locations_parent_update_validate()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_new_warehouse_id uuid;
      v_affected uuid[];
    BEGIN
      IF OLD.parent_location_id IS NOT DISTINCT FROM NEW.parent_location_id THEN
        RETURN NEW;
      END IF;

      IF NEW.type = 'warehouse' THEN
        v_new_warehouse_id := NEW.id;
      ELSE
        IF NEW.parent_location_id IS NULL THEN
          RAISE EXCEPTION 'PARENT_WAREHOUSE_ID_MISSING';
        END IF;

        SELECT warehouse_id
          INTO v_new_warehouse_id
          FROM locations
         WHERE tenant_id = NEW.tenant_id
           AND id = NEW.parent_location_id;

        IF v_new_warehouse_id IS NULL THEN
          RAISE EXCEPTION 'PARENT_WAREHOUSE_ID_MISSING';
        END IF;
      END IF;

      IF v_new_warehouse_id IS NOT DISTINCT FROM OLD.warehouse_id THEN
        RETURN NEW;
      END IF;

      WITH RECURSIVE subtree AS (
        SELECT id, tenant_id, 1 AS depth
          FROM locations
         WHERE tenant_id = NEW.tenant_id
           AND id = NEW.id
        UNION ALL
        SELECT l.id, l.tenant_id, s.depth + 1
          FROM locations l
          JOIN subtree s
            ON l.parent_location_id = s.id
           AND l.tenant_id = s.tenant_id
         WHERE s.depth < 1000
      ),
      affected AS (
        SELECT wdl.location_id
          FROM warehouse_default_location wdl
          JOIN subtree s
            ON s.id = wdl.location_id
         WHERE wdl.tenant_id = NEW.tenant_id
      )
      SELECT array_agg(location_id)
        INTO v_affected
        FROM (SELECT location_id FROM affected LIMIT 50) x;

      IF v_affected IS NOT NULL AND array_length(v_affected, 1) > 0 THEN
        RAISE EXCEPTION 'PARENT_MOVE_BREAKS_DEFAULT_LOCATION'
          USING DETAIL = format('affected_location_ids=%s', v_affected::text);
      END IF;

      RETURN NEW;
    END;
    $$;
  `);

  pgm.sql(`
    CREATE TRIGGER trg_locations_parent_update_validate
    BEFORE UPDATE ON locations
    FOR EACH ROW
    EXECUTE FUNCTION trg_locations_parent_update_validate();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_locations_parent_update_validate ON locations;
  `);
  pgm.sql(`
    DROP FUNCTION IF EXISTS trg_locations_parent_update_validate();
  `);
}

