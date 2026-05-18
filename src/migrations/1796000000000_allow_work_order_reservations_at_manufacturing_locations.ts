import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_reservation_location_sellable()
    RETURNS trigger AS $$
    DECLARE
      loc_role text;
      loc_sellable boolean;
    BEGIN
      SELECT role, is_sellable
        INTO loc_role, loc_sellable
        FROM locations
       WHERE id = NEW.location_id
         AND tenant_id = NEW.tenant_id;

      IF loc_sellable IS NULL THEN
        RAISE EXCEPTION 'RESERVATION_LOCATION_NOT_FOUND';
      END IF;

      IF NEW.demand_type = 'work_order_component' THEN
        IF loc_role NOT IN ('SELLABLE', 'FG_SELLABLE', 'FG_STAGE', 'RM_STORE', 'WIP', 'PACKAGING') THEN
          RAISE EXCEPTION 'RESERVATION_LOCATION_NOT_RESERVABLE';
        END IF;
        RETURN NEW;
      END IF;

      IF loc_sellable = false THEN
        RAISE EXCEPTION 'RESERVATION_LOCATION_NOT_SELLABLE';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_reservation_location_sellable()
    RETURNS trigger AS $$
    DECLARE
      loc_sellable boolean;
    BEGIN
      SELECT is_sellable
        INTO loc_sellable
        FROM locations
       WHERE id = NEW.location_id
         AND tenant_id = NEW.tenant_id;
      IF loc_sellable IS NULL THEN
        RAISE EXCEPTION 'RESERVATION_LOCATION_NOT_FOUND';
      END IF;
      IF loc_sellable = false THEN
        RAISE EXCEPTION 'RESERVATION_LOCATION_NOT_SELLABLE';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
}
