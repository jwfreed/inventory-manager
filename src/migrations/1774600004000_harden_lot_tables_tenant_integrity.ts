import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Harden lot-link tenant isolation and dedupe guarantees:
 * - enforce composite tenant FKs on lot link tables
 * - add race-safe uniqueness for inventory_movement_lots
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM inventory_movement_lots iml
          JOIN inventory_movement_lines l
            ON l.id = iml.inventory_movement_line_id
         WHERE iml.tenant_id <> l.tenant_id
      ) THEN
        RAISE EXCEPTION 'INVENTORY_MOVEMENT_LOTS_LINE_TENANT_MISMATCH';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM inventory_movement_lots iml
          JOIN lots l
            ON l.id = iml.lot_id
         WHERE iml.tenant_id <> l.tenant_id
      ) THEN
        RAISE EXCEPTION 'INVENTORY_MOVEMENT_LOTS_LOT_TENANT_MISMATCH';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM work_order_lot_links wol
          JOIN work_order_executions woe
            ON woe.id = wol.work_order_execution_id
         WHERE wol.tenant_id <> woe.tenant_id
      ) THEN
        RAISE EXCEPTION 'WORK_ORDER_LOT_LINKS_EXECUTION_TENANT_MISMATCH';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM work_order_lot_links wol
          JOIN lots l
            ON l.id = wol.lot_id
         WHERE wol.tenant_id <> l.tenant_id
      ) THEN
        RAISE EXCEPTION 'WORK_ORDER_LOT_LINKS_LOT_TENANT_MISMATCH';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM work_order_lot_links wol
          JOIN items i
            ON i.id = wol.item_id
         WHERE wol.tenant_id <> i.tenant_id
      ) THEN
        RAISE EXCEPTION 'WORK_ORDER_LOT_LINKS_ITEM_TENANT_MISMATCH';
      END IF;
    END $$;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_movement_lines_tenant_id_id_unique
      ON inventory_movement_lines (tenant_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lots_tenant_id_id_unique
      ON lots (tenant_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_order_executions_tenant_id_id_unique
      ON work_order_executions (tenant_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_tenant_id_id_unique
      ON items (tenant_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_movement_lots_tenant_line_lot_unique
      ON inventory_movement_lots (tenant_id, inventory_movement_line_id, lot_id);
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_inventory_movement_lots_line_tenant'
           AND conrelid = 'inventory_movement_lots'::regclass
      ) THEN
        ALTER TABLE inventory_movement_lots
          ADD CONSTRAINT fk_inventory_movement_lots_line_tenant
          FOREIGN KEY (tenant_id, inventory_movement_line_id)
          REFERENCES inventory_movement_lines(tenant_id, id)
          ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_inventory_movement_lots_lot_tenant'
           AND conrelid = 'inventory_movement_lots'::regclass
      ) THEN
        ALTER TABLE inventory_movement_lots
          ADD CONSTRAINT fk_inventory_movement_lots_lot_tenant
          FOREIGN KEY (tenant_id, lot_id)
          REFERENCES lots(tenant_id, id)
          ON DELETE RESTRICT;
      END IF;
    END $$;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_work_order_lot_links_execution_tenant'
           AND conrelid = 'work_order_lot_links'::regclass
      ) THEN
        ALTER TABLE work_order_lot_links
          ADD CONSTRAINT fk_work_order_lot_links_execution_tenant
          FOREIGN KEY (tenant_id, work_order_execution_id)
          REFERENCES work_order_executions(tenant_id, id)
          ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_work_order_lot_links_lot_tenant'
           AND conrelid = 'work_order_lot_links'::regclass
      ) THEN
        ALTER TABLE work_order_lot_links
          ADD CONSTRAINT fk_work_order_lot_links_lot_tenant
          FOREIGN KEY (tenant_id, lot_id)
          REFERENCES lots(tenant_id, id)
          ON DELETE RESTRICT;
      END IF;
    END $$;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'fk_work_order_lot_links_item_tenant'
           AND conrelid = 'work_order_lot_links'::regclass
      ) THEN
        ALTER TABLE work_order_lot_links
          ADD CONSTRAINT fk_work_order_lot_links_item_tenant
          FOREIGN KEY (tenant_id, item_id)
          REFERENCES items(tenant_id, id)
          ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE work_order_lot_links DROP CONSTRAINT IF EXISTS fk_work_order_lot_links_item_tenant;
    ALTER TABLE work_order_lot_links DROP CONSTRAINT IF EXISTS fk_work_order_lot_links_lot_tenant;
    ALTER TABLE work_order_lot_links DROP CONSTRAINT IF EXISTS fk_work_order_lot_links_execution_tenant;
    ALTER TABLE inventory_movement_lots DROP CONSTRAINT IF EXISTS fk_inventory_movement_lots_lot_tenant;
    ALTER TABLE inventory_movement_lots DROP CONSTRAINT IF EXISTS fk_inventory_movement_lots_line_tenant;
  `);

  pgm.sql(`
    DROP INDEX IF EXISTS idx_inventory_movement_lots_tenant_line_lot_unique;
    DROP INDEX IF EXISTS idx_items_tenant_id_id_unique;
    DROP INDEX IF EXISTS idx_work_order_executions_tenant_id_id_unique;
    DROP INDEX IF EXISTS idx_lots_tenant_id_id_unique;
    DROP INDEX IF EXISTS idx_inventory_movement_lines_tenant_id_id_unique;
  `);
}
