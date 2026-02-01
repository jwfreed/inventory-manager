import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS idx_locations_tenant_parent
       ON locations (tenant_id, parent_location_id)`
  );

  pgm.sql(`
    CREATE OR REPLACE FUNCTION resolve_warehouse_for_location(tenant uuid, loc uuid)
    RETURNS uuid AS $$
    DECLARE
      current_id uuid := loc;
      current_type text;
      parent_id uuid;
      depth integer := 0;
      visited uuid[] := ARRAY[]::uuid[];
    BEGIN
      IF current_id IS NULL THEN
        RETURN NULL;
      END IF;

      LOOP
        depth := depth + 1;
        IF depth > 20 THEN
          RAISE EXCEPTION 'WAREHOUSE_RESOLUTION_DEPTH_EXCEEDED';
        END IF;
        IF current_id = ANY(visited) THEN
          RAISE EXCEPTION 'WAREHOUSE_RESOLUTION_CYCLE';
        END IF;
        visited := array_append(visited, current_id);

        SELECT type, parent_location_id
          INTO current_type, parent_id
          FROM locations
         WHERE tenant_id = tenant
           AND id = current_id;

        IF NOT FOUND THEN
          RETURN NULL;
        END IF;

        IF current_type = 'warehouse' THEN
          RETURN current_id;
        END IF;

        IF parent_id IS NULL THEN
          RETURN NULL;
        END IF;

        current_id := parent_id;
      END LOOP;
    END;
    $$ LANGUAGE plpgsql STABLE;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_warehouse_default_location()
    RETURNS trigger AS $$
    DECLARE
      resolved uuid;
    BEGIN
      IF NEW.location_id IS NULL OR NEW.warehouse_id IS NULL THEN
        RAISE EXCEPTION 'WAREHOUSE_DEFAULT_LOCATION_REQUIRED';
      END IF;

      SELECT resolve_warehouse_for_location(NEW.tenant_id, NEW.location_id) INTO resolved;
      IF resolved IS NULL THEN
        RAISE EXCEPTION 'WAREHOUSE_DEFAULT_LOCATION_INVALID';
      END IF;
      IF resolved <> NEW.warehouse_id THEN
        RAISE EXCEPTION 'WAREHOUSE_DEFAULT_LOCATION_MISMATCH';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql('DROP TRIGGER IF EXISTS trg_warehouse_default_location_validate ON warehouse_default_location;');
  pgm.sql(`
    CREATE TRIGGER trg_warehouse_default_location_validate
      BEFORE INSERT OR UPDATE ON warehouse_default_location
      FOR EACH ROW
      EXECUTE FUNCTION enforce_warehouse_default_location();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS trg_warehouse_default_location_validate ON warehouse_default_location;');
  pgm.sql('DROP FUNCTION IF EXISTS enforce_warehouse_default_location();');
  pgm.sql('DROP FUNCTION IF EXISTS resolve_warehouse_for_location(uuid, uuid);');
  pgm.sql('DROP INDEX IF EXISTS idx_locations_tenant_parent;');
}
