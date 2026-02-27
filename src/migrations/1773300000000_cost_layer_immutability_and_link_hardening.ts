import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION prevent_inventory_cost_layer_mutation()
    RETURNS trigger AS $$
    BEGIN
      IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS NULL THEN
        RAISE EXCEPTION 'COST_LAYER_UNVOID_NOT_ALLOWED';
      END IF;

      IF NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
        RAISE EXCEPTION 'COST_LAYER_UNIT_COST_IMMUTABLE';
      END IF;

      IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.item_id IS DISTINCT FROM OLD.item_id
         OR NEW.location_id IS DISTINCT FROM OLD.location_id
         OR NEW.uom IS DISTINCT FROM OLD.uom
         OR NEW.layer_date IS DISTINCT FROM OLD.layer_date
         OR NEW.layer_sequence IS DISTINCT FROM OLD.layer_sequence
         OR NEW.original_quantity IS DISTINCT FROM OLD.original_quantity
         OR NEW.source_type IS DISTINCT FROM OLD.source_type
         OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
         OR NEW.movement_id IS DISTINCT FROM OLD.movement_id
         OR NEW.lot_id IS DISTINCT FROM OLD.lot_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'COST_LAYER_IMMUTABLE_FIELD_UPDATE';
      END IF;

      -- Freeze voided rows to preserve financial auditability.
      IF OLD.voided_at IS NOT NULL THEN
        IF NEW.remaining_quantity IS DISTINCT FROM OLD.remaining_quantity
           OR NEW.extended_cost IS DISTINCT FROM OLD.extended_cost
           OR NEW.notes IS DISTINCT FROM OLD.notes
           OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
           OR NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id THEN
          RAISE EXCEPTION 'COST_LAYER_VOIDED_IMMUTABLE';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_prevent_inventory_cost_layer_mutation ON inventory_cost_layers;
    CREATE TRIGGER trg_prevent_inventory_cost_layer_mutation
      BEFORE UPDATE ON inventory_cost_layers
      FOR EACH ROW
      EXECUTE FUNCTION prevent_inventory_cost_layer_mutation();
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_cost_layer_transfer_link_dimension_alignment()
    RETURNS trigger AS $$
    DECLARE
      v_out_line record;
      v_in_line record;
      v_source_layer record;
      v_dest_layer record;
    BEGIN
      SELECT id,
             tenant_id,
             item_id,
             location_id,
             COALESCE(canonical_uom, uom) AS uom
        INTO v_out_line
        FROM inventory_movement_lines
       WHERE id = NEW.transfer_out_line_id;

      SELECT id,
             tenant_id,
             item_id,
             location_id,
             COALESCE(canonical_uom, uom) AS uom
        INTO v_in_line
        FROM inventory_movement_lines
       WHERE id = NEW.transfer_in_line_id;

      SELECT id,
             tenant_id,
             item_id,
             location_id,
             uom,
             lot_id
        INTO v_source_layer
        FROM inventory_cost_layers
       WHERE id = NEW.source_cost_layer_id;

      SELECT id,
             tenant_id,
             item_id,
             location_id,
             uom,
             lot_id
        INTO v_dest_layer
        FROM inventory_cost_layers
       WHERE id = NEW.dest_cost_layer_id;

      -- Let FK / existing integrity checks handle missing references.
      IF v_out_line.id IS NULL
         OR v_in_line.id IS NULL
         OR v_source_layer.id IS NULL
         OR v_dest_layer.id IS NULL THEN
        RETURN NEW;
      END IF;

      IF v_out_line.tenant_id IS DISTINCT FROM NEW.tenant_id
         OR v_in_line.tenant_id IS DISTINCT FROM NEW.tenant_id
         OR v_source_layer.tenant_id IS DISTINCT FROM NEW.tenant_id
         OR v_dest_layer.tenant_id IS DISTINCT FROM NEW.tenant_id
         OR v_out_line.item_id IS DISTINCT FROM v_source_layer.item_id
         OR v_in_line.item_id IS DISTINCT FROM v_dest_layer.item_id
         OR v_out_line.location_id IS DISTINCT FROM v_source_layer.location_id
         OR v_in_line.location_id IS DISTINCT FROM v_dest_layer.location_id
         OR v_out_line.item_id IS DISTINCT FROM v_in_line.item_id
         OR v_source_layer.item_id IS DISTINCT FROM v_dest_layer.item_id
         OR v_out_line.uom IS DISTINCT FROM v_source_layer.uom
         OR v_in_line.uom IS DISTINCT FROM v_dest_layer.uom
         OR v_out_line.uom IS DISTINCT FROM v_in_line.uom
         OR v_source_layer.uom IS DISTINCT FROM v_dest_layer.uom
         OR (
           v_source_layer.lot_id IS NOT NULL
           AND v_dest_layer.lot_id IS NOT NULL
           AND v_source_layer.lot_id IS DISTINCT FROM v_dest_layer.lot_id
         ) THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_DIMENSION_MISMATCH';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_cost_layer_transfer_link_dimension ON cost_layer_transfer_links;
    CREATE TRIGGER trg_cost_layer_transfer_link_dimension
      BEFORE INSERT OR UPDATE ON cost_layer_transfer_links
      FOR EACH ROW
      EXECUTE FUNCTION enforce_cost_layer_transfer_link_dimension_alignment();
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_transfer_cost_item_value_conservation()
    RETURNS trigger AS $$
    DECLARE
      v_movement_id uuid;
      v_movement_type text;
      v_status text;
    BEGIN
      IF TG_TABLE_NAME = 'cost_layer_transfer_links' THEN
        v_movement_id := COALESCE(NEW.transfer_movement_id, OLD.transfer_movement_id);
      ELSE
        v_movement_id := COALESCE(NEW.movement_id, OLD.movement_id);
      END IF;

      IF v_movement_id IS NULL THEN
        RETURN NULL;
      END IF;

      SELECT movement_type, status
        INTO v_movement_type, v_status
        FROM inventory_movements
       WHERE id = v_movement_id;

      IF v_movement_type IS NULL THEN
        RETURN NULL;
      END IF;

      IF v_movement_type NOT IN ('transfer', 'transfer_reversal') OR v_status <> 'posted' THEN
        RETURN NULL;
      END IF;

      IF EXISTS (
        WITH source_value AS (
          SELECT ol.item_id,
                 COALESCE(SUM(l.quantity * scl.unit_cost), 0)::numeric AS value
            FROM cost_layer_transfer_links l
            JOIN inventory_movement_lines ol ON ol.id = l.transfer_out_line_id
            JOIN inventory_cost_layers scl ON scl.id = l.source_cost_layer_id
           WHERE l.transfer_movement_id = v_movement_id
           GROUP BY ol.item_id
        ),
        dest_value AS (
          SELECT il.item_id,
                 COALESCE(SUM(l.quantity * dcl.unit_cost), 0)::numeric AS value
            FROM cost_layer_transfer_links l
            JOIN inventory_movement_lines il ON il.id = l.transfer_in_line_id
            JOIN inventory_cost_layers dcl ON dcl.id = l.dest_cost_layer_id
           WHERE l.transfer_movement_id = v_movement_id
           GROUP BY il.item_id
        )
        SELECT 1
          FROM source_value s
          FULL OUTER JOIN dest_value d USING (item_id)
         WHERE abs(COALESCE(s.value, 0) - COALESCE(d.value, 0)) > 1e-6
      ) THEN
        RAISE EXCEPTION 'TRANSFER_COST_ITEM_VALUE_MISMATCH';
      END IF;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_transfer_cost_item_value_links ON cost_layer_transfer_links;
    CREATE CONSTRAINT TRIGGER trg_transfer_cost_item_value_links
      AFTER INSERT OR UPDATE OR DELETE ON cost_layer_transfer_links
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION enforce_transfer_cost_item_value_conservation();
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_transfer_cost_item_value_lines ON inventory_movement_lines;
    CREATE CONSTRAINT TRIGGER trg_transfer_cost_item_value_lines
      AFTER INSERT OR UPDATE OR DELETE ON inventory_movement_lines
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION enforce_transfer_cost_item_value_conservation();
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'chk_cost_layer_transfer_links_qty_positive'
      ) THEN
        ALTER TABLE cost_layer_transfer_links
          ADD CONSTRAINT chk_cost_layer_transfer_links_qty_positive
          CHECK (quantity > 0);
      END IF;
    END $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS trg_transfer_cost_item_value_lines ON inventory_movement_lines;');
  pgm.sql('DROP TRIGGER IF EXISTS trg_transfer_cost_item_value_links ON cost_layer_transfer_links;');
  pgm.sql('DROP FUNCTION IF EXISTS enforce_transfer_cost_item_value_conservation();');

  pgm.sql('DROP TRIGGER IF EXISTS trg_cost_layer_transfer_link_dimension ON cost_layer_transfer_links;');
  pgm.sql('DROP FUNCTION IF EXISTS enforce_cost_layer_transfer_link_dimension_alignment();');

  pgm.sql('DROP TRIGGER IF EXISTS trg_prevent_inventory_cost_layer_mutation ON inventory_cost_layers;');
  pgm.sql('DROP FUNCTION IF EXISTS prevent_inventory_cost_layer_mutation();');
}
