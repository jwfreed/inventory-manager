import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addConstraint('inventory_reservations', 'chk_inventory_reservations_qty_nonneg', {
    check: 'quantity_reserved >= 0 AND COALESCE(quantity_fulfilled, 0) >= 0'
  });

  pgm.addConstraint('inventory_reservations', 'chk_inventory_reservations_fulfilled_bounds', {
    check: 'COALESCE(quantity_fulfilled, 0) <= quantity_reserved'
  });

  pgm.addConstraint('inventory_balance', 'chk_inventory_balance_nonneg', {
    check: 'on_hand >= 0 AND reserved >= 0 AND allocated >= 0'
  });

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
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('inventory_balance', 'chk_inventory_balance_nonneg', { ifExists: true });
  pgm.dropConstraint('inventory_reservations', 'chk_inventory_reservations_fulfilled_bounds', { ifExists: true });
  pgm.dropConstraint('inventory_reservations', 'chk_inventory_reservations_qty_nonneg', { ifExists: true });

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
}
