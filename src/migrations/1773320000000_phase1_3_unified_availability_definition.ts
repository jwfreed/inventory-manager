import type { MigrationBuilder } from 'node-pg-migrate';

const RESERVATION_ACTIVE_STATUSES = "('RESERVED','ALLOCATED')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_on_hand_location_v AS
    SELECT iml.tenant_id,
           l.warehouse_id,
           iml.location_id,
           iml.item_id,
           COALESCE(iml.canonical_uom, iml.uom) AS uom,
           COALESCE(SUM(COALESCE(iml.quantity_delta_canonical, iml.quantity_delta)), 0)::numeric AS on_hand_qty
      FROM inventory_movement_lines iml
      JOIN inventory_movements im
        ON im.id = iml.movement_id
       AND im.tenant_id = iml.tenant_id
      JOIN locations l
        ON l.id = iml.location_id
       AND l.tenant_id = iml.tenant_id
     WHERE im.status = 'posted'
     GROUP BY iml.tenant_id,
              l.warehouse_id,
              iml.location_id,
              iml.item_id,
              COALESCE(iml.canonical_uom, iml.uom);
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_on_hand_v AS
    SELECT tenant_id,
           warehouse_id,
           item_id,
           uom,
           COALESCE(SUM(on_hand_qty), 0)::numeric AS on_hand_qty
      FROM inventory_on_hand_location_v
     GROUP BY tenant_id, warehouse_id, item_id, uom;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_commitments_location_v AS
    SELECT r.tenant_id,
           r.warehouse_id,
           r.location_id,
           r.item_id,
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
           )::numeric AS reserved_qty,
           COALESCE(
             SUM(
               CASE
                 WHEN r.status = 'ALLOCATED'
                 THEN GREATEST(0, r.quantity_reserved - COALESCE(r.quantity_fulfilled, 0))
                 ELSE 0
               END
             ),
             0
           )::numeric AS allocated_qty
      FROM inventory_reservations r
      JOIN items i
        ON i.id = r.item_id
       AND i.tenant_id = r.tenant_id
     WHERE r.status IN ${RESERVATION_ACTIVE_STATUSES}
       AND (i.canonical_uom IS NULL OR r.uom = i.canonical_uom)
     GROUP BY r.tenant_id,
              r.warehouse_id,
              r.location_id,
              r.item_id,
              COALESCE(i.canonical_uom, r.uom);
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_commitments_v AS
    SELECT tenant_id,
           warehouse_id,
           item_id,
           uom,
           COALESCE(SUM(reserved_qty), 0)::numeric AS reserved_qty,
           COALESCE(SUM(allocated_qty), 0)::numeric AS allocated_qty
      FROM inventory_commitments_location_v
     GROUP BY tenant_id, warehouse_id, item_id, uom;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_available_location_v AS
    SELECT COALESCE(oh.tenant_id, c.tenant_id) AS tenant_id,
           COALESCE(oh.warehouse_id, c.warehouse_id) AS warehouse_id,
           COALESCE(oh.location_id, c.location_id) AS location_id,
           COALESCE(oh.item_id, c.item_id) AS item_id,
           COALESCE(oh.uom, c.uom) AS uom,
           COALESCE(oh.on_hand_qty, 0)::numeric AS on_hand_qty,
           COALESCE(c.reserved_qty, 0)::numeric AS reserved_qty,
           COALESCE(c.allocated_qty, 0)::numeric AS allocated_qty,
           (
             COALESCE(oh.on_hand_qty, 0)
             - COALESCE(c.reserved_qty, 0)
             - COALESCE(c.allocated_qty, 0)
           )::numeric AS available_qty
      FROM inventory_on_hand_location_v oh
      FULL OUTER JOIN inventory_commitments_location_v c
        ON oh.tenant_id = c.tenant_id
       AND oh.warehouse_id = c.warehouse_id
       AND oh.location_id = c.location_id
       AND oh.item_id = c.item_id
       AND oh.uom = c.uom;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_available_v AS
    SELECT tenant_id,
           warehouse_id,
           item_id,
           uom,
           COALESCE(SUM(on_hand_qty), 0)::numeric AS on_hand_qty,
           COALESCE(SUM(reserved_qty), 0)::numeric AS reserved_qty,
           COALESCE(SUM(allocated_qty), 0)::numeric AS allocated_qty,
           (
             COALESCE(SUM(on_hand_qty), 0)
             - COALESCE(SUM(reserved_qty), 0)
             - COALESCE(SUM(allocated_qty), 0)
           )::numeric AS available_qty
      FROM inventory_available_location_v
     GROUP BY tenant_id, warehouse_id, item_id, uom;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_available_location_sellable_v AS
    SELECT v.tenant_id,
           v.warehouse_id,
           v.location_id,
           v.item_id,
           v.uom,
           v.on_hand_qty,
           v.reserved_qty,
           v.allocated_qty,
           v.available_qty
      FROM inventory_available_location_v v
      JOIN locations l
        ON l.id = v.location_id
       AND l.tenant_id = v.tenant_id
     WHERE l.is_sellable = true;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_available_sellable_v AS
    SELECT tenant_id,
           warehouse_id,
           item_id,
           uom,
           COALESCE(SUM(on_hand_qty), 0)::numeric AS on_hand_qty,
           COALESCE(SUM(reserved_qty), 0)::numeric AS reserved_qty,
           COALESCE(SUM(allocated_qty), 0)::numeric AS allocated_qty,
           (
             COALESCE(SUM(on_hand_qty), 0)
             - COALESCE(SUM(reserved_qty), 0)
             - COALESCE(SUM(allocated_qty), 0)
           )::numeric AS available_qty
      FROM inventory_available_location_sellable_v
     GROUP BY tenant_id, warehouse_id, item_id, uom;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_availability_location_v AS
    SELECT tenant_id,
           warehouse_id,
           item_id,
           location_id,
           uom,
           on_hand_qty AS on_hand,
           reserved_qty AS reserved,
           allocated_qty AS allocated,
           available_qty AS available
      FROM inventory_available_location_v;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_availability_v AS
    SELECT tenant_id,
           warehouse_id,
           item_id,
           uom,
           on_hand_qty AS on_hand,
           reserved_qty AS reserved,
           allocated_qty AS allocated,
           available_qty AS available
      FROM inventory_available_v;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_availability_location_sellable_v AS
    SELECT tenant_id,
           warehouse_id,
           item_id,
           location_id,
           uom,
           on_hand_qty AS on_hand,
           reserved_qty AS reserved,
           allocated_qty AS allocated,
           available_qty AS available
      FROM inventory_available_location_sellable_v;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_availability_sellable_v AS
    SELECT tenant_id,
           warehouse_id,
           item_id,
           uom,
           on_hand_qty AS on_hand,
           reserved_qty AS reserved,
           allocated_qty AS allocated,
           available_qty AS available
      FROM inventory_available_sellable_v;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_availability_all_v AS
    SELECT *
      FROM inventory_availability_v;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_availability_reconciliation_v AS
    SELECT tenant_id,
           warehouse_id,
           location_id,
           item_id,
           uom,
           on_hand_qty,
           reserved_qty,
           allocated_qty,
           available_qty,
           (on_hand_qty - (available_qty + reserved_qty + allocated_qty))::numeric AS reconciliation_diff
      FROM inventory_available_location_v
     WHERE ABS(on_hand_qty - (available_qty + reserved_qty + allocated_qty)) > 0.000001;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP VIEW IF EXISTS inventory_availability_reconciliation_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_availability_all_v;');

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

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_availability_location_sellable_v AS
    SELECT v.tenant_id,
           v.warehouse_id,
           v.item_id,
           v.location_id,
           v.uom,
           v.on_hand,
           v.reserved,
           v.allocated,
           v.available
      FROM inventory_availability_location_v v
      JOIN locations l
        ON l.id = v.location_id
       AND l.tenant_id = v.tenant_id
     WHERE l.is_sellable = true;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_availability_sellable_v AS
    SELECT tenant_id,
           warehouse_id,
           item_id,
           uom,
           COALESCE(SUM(on_hand), 0)::numeric AS on_hand,
           COALESCE(SUM(reserved), 0)::numeric AS reserved,
           COALESCE(SUM(allocated), 0)::numeric AS allocated,
           (COALESCE(SUM(on_hand), 0) - COALESCE(SUM(reserved), 0) - COALESCE(SUM(allocated), 0))::numeric AS available
      FROM inventory_availability_location_sellable_v
     GROUP BY tenant_id, warehouse_id, item_id, uom;
  `);

  pgm.sql('DROP VIEW IF EXISTS inventory_available_sellable_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_available_location_sellable_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_available_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_available_location_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_commitments_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_commitments_location_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_on_hand_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_on_hand_location_v;');
}
