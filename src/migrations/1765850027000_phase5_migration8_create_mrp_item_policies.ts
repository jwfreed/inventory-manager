import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('mrp_item_policies', {
    id: { type: 'uuid', primaryKey: true },
    mrp_run_id: { type: 'uuid', notNull: true, references: 'mrp_runs', onDelete: 'CASCADE' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    site_location_id: { type: 'uuid', references: 'locations' },
    planning_lead_time_days: { type: 'integer' },
    safety_stock_qty: { type: 'numeric(18,6)' },
    lot_sizing_method: { type: 'text', notNull: true },
    foq_qty: { type: 'numeric(18,6)' },
    poq_periods: { type: 'integer' },
    ppb_periods: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('mrp_item_policies', 'unique_mrp_item_policies_scope', {
    unique: ['mrp_run_id', 'item_id', 'uom', 'site_location_id']
  });

  pgm.addConstraint('mrp_item_policies', 'chk_mrp_item_policies', {
    check:
      '(planning_lead_time_days IS NULL OR planning_lead_time_days >= 0) AND ' +
      '(safety_stock_qty IS NULL OR safety_stock_qty >= 0) AND ' +
      "lot_sizing_method IN ('l4l','foq','poq','ppb') AND " +
      "(lot_sizing_method <> 'foq' OR foq_qty > 0) AND " +
      "(lot_sizing_method <> 'poq' OR poq_periods > 0) AND " +
      "(lot_sizing_method <> 'ppb' OR ppb_periods > 0)"
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('mrp_item_policies');
}

