import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_reservation_status_transition()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF OLD.status IN ('CANCELLED','EXPIRED','FULFILLED') AND NEW.status <> OLD.status THEN
          RAISE EXCEPTION 'RESERVATION_TERMINAL_STATE';
        END IF;

        IF OLD.status = 'RESERVED' AND NEW.status NOT IN ('RESERVED','ALLOCATED','CANCELLED','EXPIRED') THEN
          RAISE EXCEPTION 'RESERVATION_INVALID_TRANSITION';
        END IF;

        IF OLD.status = 'ALLOCATED' AND NEW.status NOT IN ('ALLOCATED','FULFILLED') THEN
          RAISE EXCEPTION 'RESERVATION_INVALID_TRANSITION';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_reservation_status_transition ON inventory_reservations;
    CREATE TRIGGER trg_reservation_status_transition
      BEFORE UPDATE OF status ON inventory_reservations
      FOR EACH ROW
      EXECUTE FUNCTION enforce_reservation_status_transition();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_reservation_status_transition()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF OLD.status IN ('CANCELLED','EXPIRED','FULFILLED') AND NEW.status <> OLD.status THEN
          RAISE EXCEPTION 'RESERVATION_TERMINAL_STATE';
        END IF;

        IF OLD.status = 'RESERVED' AND NEW.status NOT IN ('RESERVED','ALLOCATED','CANCELLED','EXPIRED') THEN
          RAISE EXCEPTION 'RESERVATION_INVALID_TRANSITION';
        END IF;

        IF OLD.status = 'ALLOCATED' AND NEW.status NOT IN ('ALLOCATED','FULFILLED','CANCELLED') THEN
          RAISE EXCEPTION 'RESERVATION_INVALID_TRANSITION';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_reservation_status_transition ON inventory_reservations;
    CREATE TRIGGER trg_reservation_status_transition
      BEFORE UPDATE OF status ON inventory_reservations
      FOR EACH ROW
      EXECUTE FUNCTION enforce_reservation_status_transition();
  `);
}
