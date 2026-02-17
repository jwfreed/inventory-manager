import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Recreate these checks using NOT VALID first so deployment does not take a full-table lock while adding.
  pgm.sql(`
    ALTER TABLE inventory_reservations
      DROP CONSTRAINT IF EXISTS chk_inventory_reservations_qty_nonneg;
    ALTER TABLE inventory_reservations
      ADD CONSTRAINT chk_inventory_reservations_qty_nonneg
      CHECK (quantity_reserved >= 0 AND COALESCE(quantity_fulfilled, 0) >= 0)
      NOT VALID;
    ALTER TABLE inventory_reservations
      VALIDATE CONSTRAINT chk_inventory_reservations_qty_nonneg;
  `);

  pgm.sql(`
    ALTER TABLE inventory_reservations
      DROP CONSTRAINT IF EXISTS chk_inventory_reservations_fulfilled_bounds;
    ALTER TABLE inventory_reservations
      ADD CONSTRAINT chk_inventory_reservations_fulfilled_bounds
      CHECK (COALESCE(quantity_fulfilled, 0) <= quantity_reserved)
      NOT VALID;
    ALTER TABLE inventory_reservations
      VALIDATE CONSTRAINT chk_inventory_reservations_fulfilled_bounds;
  `);

  pgm.sql(`
    ALTER TABLE inventory_balance
      DROP CONSTRAINT IF EXISTS chk_inventory_balance_nonneg;
    ALTER TABLE inventory_balance
      ADD CONSTRAINT chk_inventory_balance_nonneg
      CHECK (on_hand >= 0 AND reserved >= 0 AND allocated >= 0)
      NOT VALID;
    ALTER TABLE inventory_balance
      VALIDATE CONSTRAINT chk_inventory_balance_nonneg;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE inventory_balance
      DROP CONSTRAINT IF EXISTS chk_inventory_balance_nonneg;
  `);
  pgm.sql(`
    ALTER TABLE inventory_reservations
      DROP CONSTRAINT IF EXISTS chk_inventory_reservations_fulfilled_bounds;
  `);
  pgm.sql(`
    ALTER TABLE inventory_reservations
      DROP CONSTRAINT IF EXISTS chk_inventory_reservations_qty_nonneg;
  `);
}
