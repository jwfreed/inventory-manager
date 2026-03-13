import type { MigrationBuilder } from 'node-pg-migrate';

const WORK_ORDER_STATUS_VALUES = "('draft','ready','in_progress','partially_completed','completed','closed','canceled')";
const LOCATION_ROLE_VALUES = "('SELLABLE','QA','HOLD','REJECT','SCRAP','RM_STORE','WIP','PACKAGING','FG_STAGE','FG_SELLABLE')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    UPDATE work_orders
       SET status = 'ready'
     WHERE status = 'released';
  `);

  pgm.sql(`
    ALTER TABLE work_orders
      DROP CONSTRAINT IF EXISTS chk_work_orders_status;
    ALTER TABLE work_orders
      ADD CONSTRAINT chk_work_orders_status
      CHECK (status IN ${WORK_ORDER_STATUS_VALUES});
  `);

  pgm.addColumn('work_orders', {
    quantity_scrapped: { type: 'numeric(18,6)', notNull: true, default: 0 }
  });

  pgm.sql(`
    ALTER TABLE work_orders
      DROP CONSTRAINT IF EXISTS chk_work_orders_qty_completed_nonneg;
    ALTER TABLE work_orders
      ADD CONSTRAINT chk_work_orders_qty_completed_nonneg
      CHECK (
        (quantity_completed IS NULL OR quantity_completed >= 0)
        AND quantity_scrapped >= 0
      );
  `);

  pgm.sql(`
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role;
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role_sellable;

    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role
      CHECK (role IS NULL OR role IN ${LOCATION_ROLE_VALUES});

    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role_sellable
      CHECK (
        role IS NULL
        OR (
          CASE
            WHEN role IN ('SELLABLE', 'FG_SELLABLE') THEN is_sellable = true
            ELSE is_sellable = false
          END
        )
      );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    UPDATE work_orders
       SET status = 'released'
     WHERE status = 'ready';
  `);

  pgm.sql(`
    ALTER TABLE work_orders
      DROP CONSTRAINT IF EXISTS chk_work_orders_status;
    ALTER TABLE work_orders
      ADD CONSTRAINT chk_work_orders_status
      CHECK (status IN ('draft','released','in_progress','completed','canceled'));
  `);

  pgm.dropColumn('work_orders', 'quantity_scrapped', { ifExists: true });

  pgm.sql(`
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role;
    ALTER TABLE locations
      DROP CONSTRAINT IF EXISTS chk_locations_role_sellable;

    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role
      CHECK (role IS NULL OR role IN ('SELLABLE','QA','HOLD','REJECT','SCRAP'));

    ALTER TABLE locations
      ADD CONSTRAINT chk_locations_role_sellable
      CHECK (role IS NULL OR ((role = 'SELLABLE') = is_sellable));
  `);
}
