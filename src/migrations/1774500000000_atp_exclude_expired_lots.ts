import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Helper view: net expired-lot quantity that has been posted into each location
  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_expired_lot_qty_location_v AS
    SELECT iml.tenant_id,
           l.warehouse_id,
           iml.location_id,
           iml.item_id,
           COALESCE(iml.canonical_uom, iml.uom) AS uom,
           COALESCE(SUM(iml_lot.quantity_delta), 0)::numeric AS expired_qty
      FROM inventory_movement_lots iml_lot
      JOIN lots lot
        ON lot.id = iml_lot.lot_id
       AND lot.tenant_id = iml_lot.tenant_id
      JOIN inventory_movement_lines iml
        ON iml.id = iml_lot.inventory_movement_line_id
       AND iml.tenant_id = iml_lot.tenant_id
      JOIN inventory_movements im
        ON im.id = iml.movement_id
       AND im.tenant_id = iml.tenant_id
      JOIN locations l
        ON l.id = iml.location_id
       AND l.tenant_id = iml.tenant_id
     WHERE im.status = 'posted'
       AND lot.expires_at IS NOT NULL
       AND lot.expires_at < NOW()
     GROUP BY iml.tenant_id,
              l.warehouse_id,
              iml.location_id,
              iml.item_id,
              COALESCE(iml.canonical_uom, iml.uom);
  `);

  // Replace the sellable availability view to subtract expired lot qty
  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_available_location_sellable_v AS
    SELECT v.tenant_id,
           v.warehouse_id,
           v.location_id,
           v.item_id,
           v.uom,
           GREATEST(v.on_hand_qty - COALESCE(e.expired_qty, 0), 0)::numeric AS on_hand_qty,
           v.reserved_qty,
           v.allocated_qty,
           GREATEST(
             (v.on_hand_qty - COALESCE(e.expired_qty, 0))
             - v.reserved_qty
             - v.allocated_qty,
             0
           )::numeric AS available_qty
      FROM inventory_available_location_v v
      JOIN locations l
        ON l.id = v.location_id
       AND l.tenant_id = v.tenant_id
      LEFT JOIN inventory_expired_lot_qty_location_v e
        ON e.tenant_id = v.tenant_id
       AND e.warehouse_id = v.warehouse_id
       AND e.location_id = v.location_id
       AND e.item_id = v.item_id
       AND e.uom = v.uom
     WHERE l.is_sellable = true;
  `);

  // Refresh the aggregated sellable view that sums location-level rows
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

  // Refresh alias views that expose the same data under different naming
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
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Restore original sellable view without expired lot exclusion
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

  pgm.sql('DROP VIEW IF EXISTS inventory_expired_lot_qty_location_v;');
}
