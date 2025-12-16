import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('mrp_planned_orders', {
    id: { type: 'uuid', primaryKey: true },
    mrp_run_id: { type: 'uuid', notNull: true, references: 'mrp_runs', onDelete: 'CASCADE' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    site_location_id: { type: 'uuid', references: 'locations' },
    order_type: { type: 'text', notNull: true },
    quantity: { type: 'numeric(18,6)', notNull: true },
    release_date: { type: 'date', notNull: true },
    receipt_date: { type: 'date', notNull: true },
    source_ref: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('mrp_planned_orders', 'chk_mrp_planned_orders_type', {
    check: "order_type IN ('planned_work_order','planned_purchase_order')"
  });
  pgm.addConstraint('mrp_planned_orders', 'chk_mrp_planned_orders_quantity', {
    check: 'quantity > 0'
  });
  pgm.addConstraint('mrp_planned_orders', 'chk_mrp_planned_orders_dates', {
    check: 'release_date <= receipt_date'
  });

  pgm.createIndex('mrp_planned_orders', ['mrp_run_id', 'release_date'], {
    name: 'idx_mrp_planned_orders_run_release'
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('mrp_planned_orders');
}

