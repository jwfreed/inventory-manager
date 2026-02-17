import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_valuation_location_v AS
    SELECT
      tenant_id,
      item_id,
      location_id,
      uom,
      COALESCE(SUM(remaining_quantity), 0)::numeric AS qty_on_hand_costed,
      COALESCE(SUM(remaining_quantity * unit_cost), 0)::numeric AS inventory_value,
      MIN(layer_date) AS oldest_layer_date,
      MAX(layer_date) AS newest_layer_date
    FROM inventory_cost_layers
    WHERE voided_at IS NULL
      AND superseded_by_id IS NULL
      AND remaining_quantity > 0
    GROUP BY tenant_id, item_id, location_id, uom;
  `);

  pgm.sql(`
    CREATE OR REPLACE VIEW inventory_valuation_v AS
    SELECT
      tenant_id,
      item_id,
      uom,
      COALESCE(SUM(qty_on_hand_costed), 0)::numeric AS qty_on_hand_costed,
      COALESCE(SUM(inventory_value), 0)::numeric AS inventory_value,
      MIN(oldest_layer_date) AS oldest_layer_date,
      MAX(newest_layer_date) AS newest_layer_date
    FROM inventory_valuation_location_v
    GROUP BY tenant_id, item_id, uom;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP VIEW IF EXISTS inventory_valuation_v;');
  pgm.sql('DROP VIEW IF EXISTS inventory_valuation_location_v;');
}
