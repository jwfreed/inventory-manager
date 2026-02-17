import type { MigrationBuilder } from 'node-pg-migrate';

const MOVEMENT_TYPE_VALUES = "('receive','issue','transfer','adjustment','count','receipt_reversal','transfer_reversal')";
const MOVEMENT_TYPE_VALUES_PREVIOUS = "('receive','issue','transfer','adjustment','count','receipt_reversal')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE inventory_movements
      DROP CONSTRAINT IF EXISTS chk_inventory_movements_type;
    ALTER TABLE inventory_movements
      ADD CONSTRAINT chk_inventory_movements_type
      CHECK (movement_type IN ${MOVEMENT_TYPE_VALUES})
      NOT VALID;
    ALTER TABLE inventory_movements
      VALIDATE CONSTRAINT chk_inventory_movements_type;
  `);

  pgm.sql(`
    ALTER TABLE inventory_movements
      DROP CONSTRAINT IF EXISTS chk_inventory_movements_reversal_type_requires_link;
    ALTER TABLE inventory_movements
      ADD CONSTRAINT chk_inventory_movements_reversal_type_requires_link
      CHECK (movement_type NOT IN ('receipt_reversal','transfer_reversal') OR reversal_of_movement_id IS NOT NULL)
      NOT VALID;
    ALTER TABLE inventory_movements
      VALIDATE CONSTRAINT chk_inventory_movements_reversal_type_requires_link;
  `);

  pgm.sql(`
    ALTER TABLE inventory_movements
      DROP CONSTRAINT IF EXISTS chk_inventory_movements_reversal_link_requires_type;
    ALTER TABLE inventory_movements
      ADD CONSTRAINT chk_inventory_movements_reversal_link_requires_type
      CHECK (reversal_of_movement_id IS NULL OR movement_type IN ('receipt_reversal','transfer_reversal'))
      NOT VALID;
    ALTER TABLE inventory_movements
      VALIDATE CONSTRAINT chk_inventory_movements_reversal_link_requires_type;
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
      SELECT m.movement_type, m.status INTO movement_type, movement_status
        FROM inventory_movements m
       WHERE m.id = v_movement_id;
      IF movement_type NOT IN ('transfer', 'transfer_reversal') OR movement_status IS DISTINCT FROM 'posted' THEN
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

  pgm.createTable('cost_layer_transfer_links', {
    id: { type: 'uuid', primaryKey: true },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants', onDelete: 'CASCADE' },
    transfer_movement_id: { type: 'uuid', notNull: true, references: 'inventory_movements', onDelete: 'RESTRICT' },
    transfer_out_line_id: { type: 'uuid', notNull: true, references: 'inventory_movement_lines', onDelete: 'RESTRICT' },
    transfer_in_line_id: { type: 'uuid', notNull: true, references: 'inventory_movement_lines', onDelete: 'RESTRICT' },
    source_cost_layer_id: { type: 'uuid', notNull: true, references: 'inventory_cost_layers', onDelete: 'RESTRICT' },
    dest_cost_layer_id: { type: 'uuid', notNull: true, references: 'inventory_cost_layers', onDelete: 'RESTRICT' },
    quantity: { type: 'numeric(18,6)', notNull: true },
    unit_cost: { type: 'numeric(18,6)', notNull: true },
    extended_cost: { type: 'numeric(18,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('cost_layer_transfer_links', 'chk_cost_layer_transfer_links_qty_positive', {
    check: 'quantity > 0'
  });
  pgm.addConstraint('cost_layer_transfer_links', 'chk_cost_layer_transfer_links_unit_cost_nonnegative', {
    check: 'unit_cost >= 0'
  });
  pgm.addConstraint('cost_layer_transfer_links', 'chk_cost_layer_transfer_links_extended_cost_nonnegative', {
    check: 'extended_cost >= 0'
  });

  pgm.createIndex('cost_layer_transfer_links', ['tenant_id', 'transfer_movement_id'], {
    name: 'idx_cltl_tenant_movement'
  });
  pgm.createIndex('cost_layer_transfer_links', ['tenant_id', 'source_cost_layer_id'], {
    name: 'idx_cltl_tenant_source_layer'
  });
  pgm.createIndex('cost_layer_transfer_links', ['tenant_id', 'dest_cost_layer_id'], {
    name: 'idx_cltl_tenant_dest_layer'
  });
  pgm.createIndex('cost_layer_transfer_links', ['tenant_id', 'transfer_out_line_id'], {
    name: 'idx_cltl_tenant_out_line'
  });
  pgm.createIndex('cost_layer_transfer_links', ['tenant_id', 'transfer_in_line_id'], {
    name: 'idx_cltl_tenant_in_line'
  });
  pgm.createIndex('cost_layer_transfer_links', ['tenant_id', 'dest_cost_layer_id'], {
    name: 'uq_cltl_tenant_dest_layer',
    unique: true
  });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_cost_layer_transfer_link_integrity()
    RETURNS trigger AS $$
    DECLARE
      v_movement record;
      v_out_line record;
      v_in_line record;
      v_source_layer record;
      v_dest_layer record;
    BEGIN
      SELECT id, tenant_id, movement_type, status
        INTO v_movement
        FROM inventory_movements
       WHERE id = NEW.transfer_movement_id;
      IF v_movement.id IS NULL THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_MOVEMENT_NOT_FOUND';
      END IF;
      IF v_movement.tenant_id <> NEW.tenant_id THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_TENANT_MISMATCH';
      END IF;
      IF v_movement.movement_type NOT IN ('transfer', 'transfer_reversal') THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_MOVEMENT_TYPE_INVALID';
      END IF;
      IF v_movement.status <> 'posted' THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_MOVEMENT_NOT_POSTED';
      END IF;

      SELECT tenant_id,
             movement_id,
             item_id,
             location_id,
             COALESCE(quantity_delta_canonical, quantity_delta)::numeric AS quantity_delta,
             COALESCE(canonical_uom, uom) AS uom
        INTO v_out_line
        FROM inventory_movement_lines
       WHERE id = NEW.transfer_out_line_id;
      IF v_out_line.movement_id IS NULL THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_OUT_LINE_NOT_FOUND';
      END IF;
      IF v_out_line.tenant_id <> NEW.tenant_id OR v_out_line.movement_id <> NEW.transfer_movement_id THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_OUT_LINE_MISMATCH';
      END IF;
      IF v_out_line.quantity_delta >= 0 THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_OUT_LINE_SIGN_INVALID';
      END IF;

      SELECT tenant_id,
             movement_id,
             item_id,
             location_id,
             COALESCE(quantity_delta_canonical, quantity_delta)::numeric AS quantity_delta,
             COALESCE(canonical_uom, uom) AS uom
        INTO v_in_line
        FROM inventory_movement_lines
       WHERE id = NEW.transfer_in_line_id;
      IF v_in_line.movement_id IS NULL THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_IN_LINE_NOT_FOUND';
      END IF;
      IF v_in_line.tenant_id <> NEW.tenant_id OR v_in_line.movement_id <> NEW.transfer_movement_id THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_IN_LINE_MISMATCH';
      END IF;
      IF v_in_line.quantity_delta <= 0 THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_IN_LINE_SIGN_INVALID';
      END IF;

      IF v_out_line.item_id <> v_in_line.item_id THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_ITEM_MISMATCH';
      END IF;
      IF v_out_line.uom <> v_in_line.uom THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_UOM_MISMATCH';
      END IF;

      SELECT id, tenant_id, item_id, location_id, uom, unit_cost, voided_at
        INTO v_source_layer
        FROM inventory_cost_layers
       WHERE id = NEW.source_cost_layer_id;
      IF v_source_layer.id IS NULL THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_SOURCE_LAYER_NOT_FOUND';
      END IF;
      IF v_source_layer.tenant_id <> NEW.tenant_id THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_SOURCE_LAYER_TENANT_MISMATCH';
      END IF;
      IF v_source_layer.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_SOURCE_LAYER_VOIDED';
      END IF;
      IF v_source_layer.item_id <> v_out_line.item_id OR v_source_layer.location_id <> v_out_line.location_id OR v_source_layer.uom <> v_out_line.uom THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_SOURCE_LAYER_DIMENSION_MISMATCH';
      END IF;

      SELECT id, tenant_id, item_id, location_id, uom, unit_cost, voided_at
        INTO v_dest_layer
        FROM inventory_cost_layers
       WHERE id = NEW.dest_cost_layer_id;
      IF v_dest_layer.id IS NULL THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_DEST_LAYER_NOT_FOUND';
      END IF;
      IF v_dest_layer.tenant_id <> NEW.tenant_id THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_DEST_LAYER_TENANT_MISMATCH';
      END IF;
      IF v_dest_layer.voided_at IS NOT NULL THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_DEST_LAYER_VOIDED';
      END IF;
      IF v_dest_layer.item_id <> v_in_line.item_id OR v_dest_layer.location_id <> v_in_line.location_id OR v_dest_layer.uom <> v_in_line.uom THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_DEST_LAYER_DIMENSION_MISMATCH';
      END IF;

      IF abs(COALESCE(v_source_layer.unit_cost, 0)::numeric - NEW.unit_cost) > 1e-6 THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_UNIT_COST_SOURCE_MISMATCH';
      END IF;
      IF abs(COALESCE(v_dest_layer.unit_cost, 0)::numeric - NEW.unit_cost) > 1e-6 THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_UNIT_COST_DEST_MISMATCH';
      END IF;
      IF abs(NEW.extended_cost - (NEW.quantity * NEW.unit_cost)) > 1e-6 THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_EXTENDED_COST_MISMATCH';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_cost_layer_transfer_link_integrity ON cost_layer_transfer_links;
    CREATE TRIGGER trg_cost_layer_transfer_link_integrity
      BEFORE INSERT OR UPDATE ON cost_layer_transfer_links
      FOR EACH ROW
      EXECUTE FUNCTION enforce_cost_layer_transfer_link_integrity();
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_transfer_cost_conservation()
    RETURNS trigger AS $$
    DECLARE
      v_movement_id uuid;
      v_movement_type text;
      v_status text;
      v_source_value numeric;
      v_dest_value numeric;
      v_link_value numeric;
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
        SELECT 1
          FROM cost_layer_transfer_links l
          JOIN inventory_movement_lines ol ON ol.id = l.transfer_out_line_id
          JOIN inventory_movement_lines il ON il.id = l.transfer_in_line_id
         WHERE l.transfer_movement_id = v_movement_id
           AND (ol.movement_id <> v_movement_id OR il.movement_id <> v_movement_id)
      ) THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_MOVEMENT_MISMATCH';
      END IF;

      IF EXISTS (
        WITH out_lines AS (
          SELECT id,
                 abs(COALESCE(quantity_delta_canonical, quantity_delta))::numeric AS qty
            FROM inventory_movement_lines
           WHERE movement_id = v_movement_id
             AND COALESCE(quantity_delta_canonical, quantity_delta) < 0
        ),
        linked AS (
          SELECT transfer_out_line_id AS line_id,
                 COALESCE(SUM(quantity), 0)::numeric AS qty
            FROM cost_layer_transfer_links
           WHERE transfer_movement_id = v_movement_id
           GROUP BY transfer_out_line_id
        )
        SELECT 1
          FROM out_lines o
          LEFT JOIN linked l ON l.line_id = o.id
         WHERE abs(o.qty - COALESCE(l.qty, 0)) > 1e-6
      ) THEN
        RAISE EXCEPTION 'TRANSFER_COST_OUT_QTY_MISMATCH';
      END IF;

      IF EXISTS (
        WITH in_lines AS (
          SELECT id,
                 COALESCE(quantity_delta_canonical, quantity_delta)::numeric AS qty
            FROM inventory_movement_lines
           WHERE movement_id = v_movement_id
             AND COALESCE(quantity_delta_canonical, quantity_delta) > 0
        ),
        linked AS (
          SELECT transfer_in_line_id AS line_id,
                 COALESCE(SUM(quantity), 0)::numeric AS qty
            FROM cost_layer_transfer_links
           WHERE transfer_movement_id = v_movement_id
           GROUP BY transfer_in_line_id
        )
        SELECT 1
          FROM in_lines i
          LEFT JOIN linked l ON l.line_id = i.id
         WHERE abs(i.qty - COALESCE(l.qty, 0)) > 1e-6
      ) THEN
        RAISE EXCEPTION 'TRANSFER_COST_IN_QTY_MISMATCH';
      END IF;

      SELECT
        COALESCE(SUM(l.quantity * scl.unit_cost), 0)::numeric,
        COALESCE(SUM(l.quantity * dcl.unit_cost), 0)::numeric,
        COALESCE(SUM(l.extended_cost), 0)::numeric
        INTO v_source_value, v_dest_value, v_link_value
        FROM cost_layer_transfer_links l
        JOIN inventory_cost_layers scl ON scl.id = l.source_cost_layer_id
        JOIN inventory_cost_layers dcl ON dcl.id = l.dest_cost_layer_id
       WHERE l.transfer_movement_id = v_movement_id;

      IF abs(v_source_value - v_dest_value) > 1e-6 THEN
        RAISE EXCEPTION 'TRANSFER_COST_VALUE_MISMATCH';
      END IF;
      IF abs(v_source_value - v_link_value) > 1e-6 THEN
        RAISE EXCEPTION 'TRANSFER_COST_LINK_VALUE_MISMATCH';
      END IF;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_transfer_cost_conservation_links ON cost_layer_transfer_links;
    CREATE CONSTRAINT TRIGGER trg_transfer_cost_conservation_links
      AFTER INSERT OR UPDATE OR DELETE ON cost_layer_transfer_links
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION enforce_transfer_cost_conservation();
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_transfer_cost_conservation_lines ON inventory_movement_lines;
    CREATE CONSTRAINT TRIGGER trg_transfer_cost_conservation_lines
      AFTER INSERT OR UPDATE OR DELETE ON inventory_movement_lines
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION enforce_transfer_cost_conservation();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TRIGGER IF EXISTS trg_transfer_cost_conservation_lines ON inventory_movement_lines;');
  pgm.sql('DROP TRIGGER IF EXISTS trg_transfer_cost_conservation_links ON cost_layer_transfer_links;');
  pgm.sql('DROP FUNCTION IF EXISTS enforce_transfer_cost_conservation();');
  pgm.sql('DROP TRIGGER IF EXISTS trg_cost_layer_transfer_link_integrity ON cost_layer_transfer_links;');
  pgm.sql('DROP FUNCTION IF EXISTS enforce_cost_layer_transfer_link_integrity();');

  pgm.dropTable('cost_layer_transfer_links', { ifExists: true });

  pgm.dropConstraint('inventory_movements', 'chk_inventory_movements_reversal_link_requires_type', { ifExists: true });
  pgm.dropConstraint('inventory_movements', 'chk_inventory_movements_reversal_type_requires_link', { ifExists: true });
  pgm.addConstraint(
    'inventory_movements',
    'chk_inventory_movements_reversal_type_requires_link',
    "CHECK (movement_type <> 'receipt_reversal' OR reversal_of_movement_id IS NOT NULL)"
  );
  pgm.addConstraint(
    'inventory_movements',
    'chk_inventory_movements_reversal_link_requires_type',
    "CHECK (reversal_of_movement_id IS NULL OR movement_type = 'receipt_reversal')"
  );

  pgm.dropConstraint('inventory_movements', 'chk_inventory_movements_type', { ifExists: true });
  pgm.addConstraint(
    'inventory_movements',
    'chk_inventory_movements_type',
    `CHECK (movement_type IN ${MOVEMENT_TYPE_VALUES_PREVIOUS})`
  );

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
