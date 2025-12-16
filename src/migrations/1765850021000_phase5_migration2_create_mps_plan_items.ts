import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('mps_plan_items', {
    id: { type: 'uuid', primaryKey: true },
    mps_plan_id: { type: 'uuid', notNull: true, references: 'mps_plans', onDelete: 'CASCADE' },
    item_id: { type: 'uuid', notNull: true, references: 'items' },
    uom: { type: 'text', notNull: true },
    site_location_id: { type: 'uuid', references: 'locations' },
    safety_stock_qty: { type: 'numeric(18,6)' },
    lot_size_qty: { type: 'numeric(18,6)' },
    lead_time_days: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('mps_plan_items', 'unique_mps_plan_item_scope', {
    unique: ['mps_plan_id', 'item_id', 'uom', 'site_location_id']
  });
  pgm.addConstraint('mps_plan_items', 'chk_mps_plan_items_qtys', {
    check:
      '(safety_stock_qty IS NULL OR safety_stock_qty >= 0) AND ' +
      '(lot_size_qty IS NULL OR lot_size_qty > 0) AND ' +
      '(lead_time_days IS NULL OR lead_time_days >= 0)'
  });

  pgm.createIndex('mps_plan_items', 'mps_plan_id', { name: 'idx_mps_plan_items_plan' });
  pgm.createIndex('mps_plan_items', 'item_id', { name: 'idx_mps_plan_items_item' });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('mps_plan_items');
}

