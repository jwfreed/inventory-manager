import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION prevent_update_delete_posted_inventory_movements()
    RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'posted' THEN
        RAISE EXCEPTION 'POSTED_INVENTORY_MOVEMENT_IMMUTABLE';
      END IF;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION prevent_update_delete_posted_inventory_movement_lines()
    RETURNS trigger AS $$
    DECLARE
      movement_status text;
    BEGIN
      SELECT status INTO movement_status FROM inventory_movements WHERE id = OLD.movement_id;
      IF movement_status = 'posted' THEN
        RAISE EXCEPTION 'POSTED_INVENTORY_MOVEMENT_LINE_IMMUTABLE';
      END IF;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_transfer_balance()
    RETURNS trigger AS $$
    DECLARE
      v_movement_id uuid;
      movement_type text;
      movement_status text;
      sum_qty numeric;
      uom_count integer;
    BEGIN
      v_movement_id := COALESCE(NEW.movement_id, OLD.movement_id);
      SELECT movement_type, status INTO movement_type, movement_status
        FROM inventory_movements
       WHERE id = v_movement_id;
      IF movement_type IS DISTINCT FROM 'transfer' OR movement_status IS DISTINCT FROM 'posted' THEN
        RETURN NULL;
      END IF;
      SELECT
        COALESCE(SUM(COALESCE(quantity_delta_canonical, quantity_delta)), 0),
        COUNT(DISTINCT COALESCE(canonical_uom, uom))
        INTO sum_qty, uom_count
        FROM inventory_movement_lines
       WHERE movement_id = v_movement_id;
      IF uom_count > 1 THEN
        RAISE EXCEPTION 'TRANSFER_UOM_MISMATCH';
      END IF;
      IF ABS(sum_qty) > 1e-6 THEN
        RAISE EXCEPTION 'TRANSFER_NOT_BALANCED';
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER trg_inventory_movements_immutable
      BEFORE UPDATE OR DELETE ON inventory_movements
      FOR EACH ROW
      EXECUTE FUNCTION prevent_update_delete_posted_inventory_movements();
  `);

  pgm.sql(`
    CREATE TRIGGER trg_inventory_movement_lines_immutable
      BEFORE UPDATE OR DELETE ON inventory_movement_lines
      FOR EACH ROW
      EXECUTE FUNCTION prevent_update_delete_posted_inventory_movement_lines();
  `);

  pgm.sql(`
    CREATE CONSTRAINT TRIGGER trg_inventory_transfer_balance
      AFTER INSERT OR UPDATE OR DELETE ON inventory_movement_lines
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION enforce_transfer_balance();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS trg_inventory_transfer_balance ON inventory_movement_lines;');
  pgm.sql('DROP TRIGGER IF EXISTS trg_inventory_movement_lines_immutable ON inventory_movement_lines;');
  pgm.sql('DROP TRIGGER IF EXISTS trg_inventory_movements_immutable ON inventory_movements;');
  pgm.sql('DROP FUNCTION IF EXISTS enforce_transfer_balance();');
  pgm.sql('DROP FUNCTION IF EXISTS prevent_update_delete_posted_inventory_movement_lines();');
  pgm.sql('DROP FUNCTION IF EXISTS prevent_update_delete_posted_inventory_movements();');
}
