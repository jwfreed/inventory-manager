import type { MigrationBuilder } from 'node-pg-migrate';

const RESERVATION_ACTIVE_STATUSES = "('RESERVED','ALLOCATED')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    UPDATE inventory_reservations
       SET warehouse_id = resolve_warehouse_for_location(tenant_id, location_id)
     WHERE warehouse_id IS NULL;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM inventory_reservations
         WHERE warehouse_id IS NULL
      ) THEN
        RAISE EXCEPTION 'RESERVATION_WAREHOUSE_REQUIRED';
      END IF;
    END $$;
  `);

  pgm.alterColumn('inventory_reservations', 'warehouse_id', { notNull: true });

  pgm.sql(`
    CREATE OR REPLACE FUNCTION trg_inventory_reservations_sync_warehouse()
    RETURNS trigger AS $$
    DECLARE
      resolved uuid;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.location_id IS DISTINCT FROM OLD.location_id THEN
          RAISE EXCEPTION 'RESERVATION_LOCATION_IMMUTABLE';
        END IF;
        IF NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id THEN
          RAISE EXCEPTION 'RESERVATION_WAREHOUSE_IMMUTABLE';
        END IF;
      END IF;

      SELECT resolve_warehouse_for_location(NEW.tenant_id, NEW.location_id) INTO resolved;
      IF resolved IS NULL THEN
        RAISE EXCEPTION 'RESERVATION_WAREHOUSE_REQUIRED';
      END IF;

      IF TG_OP = 'INSERT' AND NEW.warehouse_id IS NULL THEN
        NEW.warehouse_id := resolved;
      END IF;

      IF NEW.warehouse_id IS NULL THEN
        RAISE EXCEPTION 'RESERVATION_WAREHOUSE_REQUIRED';
      END IF;

      IF NEW.warehouse_id <> resolved THEN
        RAISE EXCEPTION 'RESERVATION_WAREHOUSE_MISMATCH';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_inventory_reservations_sync_warehouse ON inventory_reservations;
    CREATE TRIGGER trg_inventory_reservations_sync_warehouse
      BEFORE INSERT OR UPDATE
      ON inventory_reservations
      FOR EACH ROW
      EXECUTE FUNCTION trg_inventory_reservations_sync_warehouse();
  `);

  pgm.dropConstraint('inventory_reservations', 'chk_inventory_reservations_warehouse_matches_location', {
    ifExists: true
  });
  pgm.sql(`
    ALTER TABLE inventory_reservations
      ADD CONSTRAINT chk_inventory_reservations_warehouse_matches_location
      CHECK (warehouse_id = resolve_warehouse_for_location(tenant_id, location_id))
      NOT VALID;
  `);

  pgm.createIndex('inventory_movement_lines', ['tenant_id', 'item_id', 'location_id'], {
    name: 'idx_iml_tenant_item_location'
  });
  pgm.createIndex('inventory_reservations', ['tenant_id', 'warehouse_id', 'item_id', 'status'], {
    name: 'idx_reservations_tenant_warehouse_item_status'
  });

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_availability_location_v AS
    WITH on_hand AS (
      SELECT iml.tenant_id,
             l.warehouse_id,
             iml.item_id,
             iml.location_id,
             COALESCE(iml.canonical_uom, iml.uom) AS uom,
             COALESCE(SUM(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)), 0)::numeric AS on_hand
        FROM inventory_movement_lines iml
        JOIN inventory_movements im
          ON im.id = iml.movement_id
         AND im.tenant_id = iml.tenant_id
        JOIN locations l
          ON l.id = iml.location_id
         AND l.tenant_id = iml.tenant_id
       WHERE im.status = 'posted'
       GROUP BY iml.tenant_id, l.warehouse_id, iml.item_id, iml.location_id, COALESCE(iml.canonical_uom, iml.uom)
    ),
    commitments AS (
      SELECT r.tenant_id,
             r.warehouse_id,
             r.item_id,
             r.location_id,
             COALESCE(i.canonical_uom, r.uom) AS uom,
             COALESCE(
               SUM(
                 CASE
                   WHEN r.status = 'RESERVED'
                   THEN GREATEST(0, r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0))
                   ELSE 0
                 END
               ),
               0
             )::numeric AS reserved,
             COALESCE(
               SUM(
                 CASE
                   WHEN r.status = 'ALLOCATED'
                   THEN GREATEST(0, r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0))
                   ELSE 0
                 END
               ),
               0
             )::numeric AS allocated
        FROM inventory_reservations r
        JOIN items i
          ON i.id = r.item_id
         AND i.tenant_id = r.tenant_id
       WHERE r.status IN ${RESERVATION_ACTIVE_STATUSES}
         AND (i.canonical_uom IS NULL OR r.uom = i.canonical_uom)
       GROUP BY r.tenant_id, r.warehouse_id, r.item_id, r.location_id, COALESCE(i.canonical_uom, r.uom)
    )
    SELECT COALESCE(oh.tenant_id, c.tenant_id) AS tenant_id,
           COALESCE(oh.warehouse_id, c.warehouse_id) AS warehouse_id,
           COALESCE(oh.item_id, c.item_id) AS item_id,
           COALESCE(oh.location_id, c.location_id) AS location_id,
           COALESCE(oh.uom, c.uom) AS uom,
           COALESCE(oh.on_hand, 0)::numeric AS on_hand,
           COALESCE(c.reserved, 0)::numeric AS reserved,
           COALESCE(c.allocated, 0)::numeric AS allocated,
           (COALESCE(oh.on_hand, 0) - COALESCE(c.reserved, 0) - COALESCE(c.allocated, 0))::numeric AS available
      FROM on_hand oh
      FULL OUTER JOIN commitments c
        ON oh.tenant_id = c.tenant_id
       AND oh.warehouse_id = c.warehouse_id
       AND oh.item_id = c.item_id
       AND oh.location_id = c.location_id
       AND oh.uom = c.uom;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_availability_v AS
    SELECT tenant_id,
           warehouse_id,
           item_id,
           uom,
           COALESCE(SUM(on_hand), 0)::numeric AS on_hand,
           COALESCE(SUM(reserved), 0)::numeric AS reserved,
           COALESCE(SUM(allocated), 0)::numeric AS allocated,
           (COALESCE(SUM(on_hand), 0) - COALESCE(SUM(reserved), 0) - COALESCE(SUM(allocated), 0))::numeric AS available
      FROM inventory_availability_location_v
     GROUP BY tenant_id, warehouse_id, item_id, uom;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP VIEW IF EXISTS inventory_availability_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_availability_location_v;');

  pgm.dropIndex('inventory_reservations', ['tenant_id', 'warehouse_id', 'item_id', 'status'], {
    name: 'idx_reservations_tenant_warehouse_item_status',
    ifExists: true
  });
  pgm.dropIndex('inventory_movement_lines', ['tenant_id', 'item_id', 'location_id'], {
    name: 'idx_iml_tenant_item_location',
    ifExists: true
  });

  pgm.dropConstraint('inventory_reservations', 'chk_inventory_reservations_warehouse_matches_location', {
    ifExists: true
  });
  pgm.sql('DROP TRIGGER IF EXISTS trg_inventory_reservations_sync_warehouse ON inventory_reservations;');
  pgm.sql('DROP FUNCTION IF EXISTS trg_inventory_reservations_sync_warehouse();');
  pgm.alterColumn('inventory_reservations', 'warehouse_id', { notNull: false });
}
