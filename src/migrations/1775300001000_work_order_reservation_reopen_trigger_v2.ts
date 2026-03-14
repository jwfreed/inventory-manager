import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_reservation_status_transition_v2()
    RETURNS trigger AS $$
    DECLARE
      old_fulfilled numeric(18,6);
      new_fulfilled numeric(18,6);
      derived_status text;
    BEGIN
      new_fulfilled := COALESCE(NEW.quantity_fulfilled, 0);

      IF NEW.quantity_reserved < 0 OR new_fulfilled < 0 OR new_fulfilled > NEW.quantity_reserved THEN
        RAISE EXCEPTION 'RESERVATION_INVALID_FULFILLMENT_BOUNDS';
      END IF;

      IF new_fulfilled = 0 THEN
        derived_status := 'RESERVED';
      ELSIF new_fulfilled = NEW.quantity_reserved THEN
        derived_status := 'FULFILLED';
      ELSE
        derived_status := 'ALLOCATED';
      END IF;

      IF TG_OP = 'INSERT' THEN
        IF NEW.demand_type = 'work_order_component' AND NEW.status NOT IN ('CANCELLED', 'EXPIRED') THEN
          NEW.status := derived_status;
        END IF;
        RETURN NEW;
      END IF;

      old_fulfilled := COALESCE(OLD.quantity_fulfilled, 0);

      IF OLD.status IN ('CANCELLED', 'EXPIRED') THEN
        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.quantity_reserved IS DISTINCT FROM OLD.quantity_reserved
           OR new_fulfilled IS DISTINCT FROM old_fulfilled THEN
          RAISE EXCEPTION 'RESERVATION_TERMINAL_STATE';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.demand_type = 'work_order_component' THEN
        IF OLD.status = 'FULFILLED' THEN
          IF NEW.status IN ('CANCELLED', 'EXPIRED') AND NEW.status IS DISTINCT FROM OLD.status THEN
            RAISE EXCEPTION 'RESERVATION_TERMINAL_STATE';
          END IF;

          IF new_fulfilled > old_fulfilled THEN
            RAISE EXCEPTION 'RESERVATION_INVALID_TRANSITION';
          ELSIF new_fulfilled < old_fulfilled THEN
            NEW.status := derived_status;
            RETURN NEW;
          ELSIF derived_status <> 'FULFILLED' THEN
            RAISE EXCEPTION 'RESERVATION_TERMINAL_STATE';
          END IF;

          NEW.status := 'FULFILLED';
          RETURN NEW;
        END IF;

        IF NEW.status IN ('CANCELLED', 'EXPIRED') THEN
          RETURN NEW;
        END IF;

        NEW.status := derived_status;
        RETURN NEW;
      END IF;

      IF OLD.status = 'FULFILLED' THEN
        IF NEW.status IS DISTINCT FROM OLD.status
           OR NEW.quantity_reserved IS DISTINCT FROM OLD.quantity_reserved
           OR new_fulfilled IS DISTINCT FROM old_fulfilled THEN
          RAISE EXCEPTION 'RESERVATION_TERMINAL_STATE';
        END IF;
        RETURN NEW;
      END IF;

      IF OLD.status = 'RESERVED' AND NEW.status NOT IN ('RESERVED','ALLOCATED','CANCELLED','EXPIRED') THEN
        RAISE EXCEPTION 'RESERVATION_INVALID_TRANSITION';
      END IF;

      IF OLD.status = 'ALLOCATED' AND NEW.status NOT IN ('ALLOCATED','FULFILLED','CANCELLED') THEN
        RAISE EXCEPTION 'RESERVATION_INVALID_TRANSITION';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_reservation_status_transition ON inventory_reservations;
    CREATE TRIGGER trg_reservation_status_transition
      BEFORE INSERT OR UPDATE OF status, quantity_reserved, quantity_fulfilled ON inventory_reservations
      FOR EACH ROW
      EXECUTE FUNCTION enforce_reservation_status_transition_v2();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_reservation_status_transition ON inventory_reservations;
    CREATE TRIGGER trg_reservation_status_transition
      BEFORE UPDATE OF status ON inventory_reservations
      FOR EACH ROW
      EXECUTE FUNCTION enforce_reservation_status_transition();
  `);

  pgm.sql('DROP FUNCTION IF EXISTS enforce_reservation_status_transition_v2();');
}
