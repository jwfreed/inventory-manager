import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
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

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_availability_all_v AS
    SELECT *
      FROM inventory_availability_v;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP VIEW IF EXISTS inventory_availability_all_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_availability_sellable_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_availability_location_sellable_v;');
}
