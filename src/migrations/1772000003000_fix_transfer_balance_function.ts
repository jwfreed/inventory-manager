import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
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
      SELECT m.movement_type, m.status INTO movement_type, movement_status
        FROM inventory_movements m
       WHERE m.id = v_movement_id;
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
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // No-op: keep latest corrected function definition.
}
