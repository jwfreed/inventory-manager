import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
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

  pgm.sql('DROP TRIGGER IF EXISTS trg_inventory_reservations_sellable ON inventory_reservations;');
  pgm.sql(`
    CREATE TRIGGER trg_inventory_reservations_sellable
      BEFORE INSERT OR UPDATE OF location_id ON inventory_reservations
      FOR EACH ROW
      EXECUTE FUNCTION enforce_reservation_location_sellable();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS trg_inventory_reservations_sellable ON inventory_reservations;');
  pgm.sql('DROP FUNCTION IF EXISTS enforce_reservation_location_sellable();');
}
